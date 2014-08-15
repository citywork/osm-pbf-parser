var zlib = require('zlib');
var parsers = require('./lib/parsers.js');
var Transform = require('readable-stream').Transform;
var inherits = require('inherits');

module.exports = Parser;
inherits(Parser, Transform);

var SIZE = 0, HEADER = 1, BLOB = 2;

function Parser () {
    if (!(this instanceof Parser)) return new Parser;
    Transform.call(this);
    this._readableState.objectMode = true;
    this._readableState.highWaterMark = 0;
    this._writableState.objectMode = false;
    this._mode = SIZE;
    this._waiting = 4;
    this._prev = null;
    this._header = null;
    this._osmheader = null;
    this._osmdata = null;
    this._blob = null;
    this._offset = 0;
    this._sizeOffset = null;
}

Parser.prototype._transform = function write (buf, enc, next) {
    var self = this;
    
    if (this._prev) {
        buf = Buffer.concat([ this._prev, buf ]);
        this._prev = null;
    }
    if (buf.length < this._waiting) {
        this._prev = buf;
        return next();
    }
    
    if (this._mode === SIZE) {
        this._sizeOffset = this._offset;
        var len = buf.readUInt32BE(0);
        this._mode = HEADER;
        this._offset += this._waiting;
        this._waiting = len;
        write.call(this, buf.slice(4), enc, next);
    }
    else if (this._mode === HEADER) {
        this._header = parsers.file.BlobHeader.decode(buf.slice(0, this._waiting));
        this._mode = BLOB;
        var nbuf = buf.slice(this._waiting);
        this._offset += this._waiting;
        this._waiting = this._header.datasize;
        write.call(this, nbuf, enc, next);
    }
    else if (this._mode === BLOB) {
        this._blob = parsers.file.Blob.decode(buf.slice(0, this._waiting));
        
        var h = this._header;
        var o = this._offset;

        this._mode = SIZE;
        var nbuf = buf.slice(this._waiting);
        this._offset += this._waiting;
        this._waiting = 4;

        if (!this._blob.zlib_data) {
            throw "No zlib data, possibly unimplemented raw/lzma/bz2 data";
        }
        zlib.inflate(this._blob.zlib_data, function (err, data) {
            if (err) self.emit('error', err);
            
            if (h.type === 'OSMHeader') {
                self._osmheader = parsers.osm.HeaderBlock.decode(data);
                if (self._osmheader.required_features.indexOf('HistoricalInformation') >= 0) {
                    self._osmheader.HistoricalInformation = true;
                }
            }
            else if (h.type === 'OSMData') {
                var block = parsers.osm.PrimitiveBlock.decode(data);
                var stringtable = decodeStringtable(block.stringtable.s);
                // Output:
                var items = [];
                block.primitivegroup.forEach(function(group) {
                    if (group.dense) {
                        parseDenseNodes(group.dense, self._osmheader, stringtable, items);
                    }
                    group.ways.forEach(function(way) {
                        parseWay(way, self._osmheader, stringtable, items);
                    });
                    group.relations.forEach(function(relation) {
                        parseRelation(relation, self._osmheader, stringtable, items);
                    });
                    if (group.nodes && group.nodes.length > 0) {
                        console.warn(group.nodes.length + " unimplemented nodes");
                    }
                    if (group.changesets && group.changesets.length > 0) {
                        console.warn(group.changesets.length + " unimplemented changesets");
                    }
                });

                if (items.length > 0) {
                    self.push(items);
                }
            }

            write.call(self, nbuf, enc, next);
        });
    }
}

function decodeStringtable (bufs) {
    return bufs.map(function(buf) {
            if (!Buffer.isBuffer(buf))
                throw "no buffer";
            return buf.toString('utf8');
        });
}

var NANO = 1e-9;

function parseDenseNodes(dense, osmheader, stringtable, results) {
    // TODO: schema specifies default granularity/date_granularity already,
    // https://github.com/mafintosh/protocol-buffers/issues/10
    var g = NANO * (osmheader.granularity || 100);
    var lat0 = NANO * (osmheader.lat_offset || 0);
    var lon0 = NANO * (osmheader.lon_offset || 0);
    var id = 0, lat = 0, lon = 0;
    var dg = osmheader.date_granularity || 1000;
    var timestamp = 0, changeset = 0, uid = 0, user_sid = 0;
    var offset = 0, tagsOffset = 0;
    for(; offset < dense.id.length; offset++) {
        id += dense.id[offset];
        lat += dense.lat[offset];
        lon += dense.lon[offset];
        var tags = {};
        for(; tagsOffset < dense.keys_vals.length - 1 && dense.keys_vals[tagsOffset] !== 0; tagsOffset += 2) {
            var k = stringtable[dense.keys_vals[tagsOffset]];
            var v = stringtable[dense.keys_vals[tagsOffset + 1]];
            tags[k] = v;
        }
        // Skip the 0
        tagsOffset += 1;

        var node = {
            type: 'node',
            id: id,
            lat: lat0 + g * lat,
            lon: lon0 + g * lon,
            tags: tags
        };


        var dInfo;
        if ((dInfo = dense.denseinfo)) {
            timestamp += dInfo.timestamp[offset];
            changeset += dInfo.changeset[offset];
            uid += dInfo.uid[offset];
            user_sid += dInfo.user_sid[offset];
            node.info = {
                version: dInfo.version[offset],
                id: id,
                timestamp: dg * timestamp,
                changeset: changeset,
                uid: uid,
                user: stringtable[user_sid]
            };
            if (osmheader.HistoricalInformation && dInfo.hasOwnProperty('visible')) {
                node.info.visible = dInfo.visible[offset];
            }
        }

        results.push(node);
    }
}

function parseWay(data, osmheader, stringtable, results) {
    var tags = {};
    for(var i = 0; i < data.keys.length && i < data.vals.length; i++) {
        var k = stringtable[data.keys[i]];
        var v = stringtable[data.vals[i]];
        tags[k] = v;
    }

    var ref = 0;
    var refs = data.refs.map(function(ref1) {
        ref += ref1;
        return ref;
    });

    var way = {
        type: 'way',
        id: data.id,
        tags: tags,
        refs: refs
    };

    if (data.info) {
        way.info = parseInfo(data.info, osmheader, stringtable);
    }

    results.push(way);
}

function parseRelation(data, osmheader, stringtable, results) {
    var i;
    var tags = {};
    for(i = 0; i < data.keys.length && i < data.vals.length; i++) {
        var k = stringtable[data.keys[i]];
        var v = stringtable[data.vals[i]];
        tags[k] = v;
    }

    var id = 0;
    var members = [];
    for(i = 0; i < data.roles_sid.length && i < data.memids.length && i < data.types.length; i++) {
        id += data.memids[i];
        var typeStr;
        switch(data.types[i]) {
        case 0:
            typeStr = 'node';
            break;
        case 1:
            typeStr = 'way';
            break;
        case 2:
            typeStr = 'relation';
            break;
        default:
            typeStr = '?';
        }

        members.push({
            type: typeStr,
            id: id,
            role: stringtable[data.roles_sid[i]]
        });
    }

    var relation = {
        type: 'relation',
        id: data.id,
        tags: tags,
        members: members
    };
    if (data.info) {
        relation.info = parseInfo(data.info, osmheader, stringtable);
    }

    results.push(relation);
}

function parseInfo(dInfo, osmheader, stringtable) {
    var dg = osmheader.date_granularity || 1000;
    var info = {
        version: dInfo.version,
        timestamp: dg * dInfo.timestamp,
        changeset: dInfo.changeset,
        uid: dInfo.uid,
        user: stringtable[dInfo.user_sid]
    };
    if (osmheader.HistoricalInformation && dInfo.hasOwnProperty('visible')) {
        info.visible = dInfo.visible;
    }
    return info;
}
