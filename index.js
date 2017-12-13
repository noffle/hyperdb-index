var events = require('events')
var inherits = require('inherits')
var through = require('through2')
var pump = require('pump')
var versions = require('./lib/version')

module.exports = Index

function Index (db, opts) {
  if (!(this instanceof Index)) return new Index(db, opts)
  opts = opts || {}

  if (!db) throw new Error('no argument "db" provided')
  if (!opts.processFn) throw new Error('no argument "processFn" provided')
  if (typeof opts.processFn !== 'function') throw new Error('no argument "processFn" provided')
  if (!opts.getVersion) throw new Error('no argument "opts.getVersion" provided')
  if (!opts.setVersion) throw new Error('no argument "opts.setVersion" provided')

  events.EventEmitter.call(this)

  opts.prefix = opts.prefix || '/'

  this._db = db
  this._prefix = opts.prefix
  this._processFn = opts.processFn
  this._getVersion = opts.getVersion
  this._setVersion = opts.setVersion

  this._indexRunning = true

  // Kick off the indexing
  this._run()

  // TODO: some way to 'deactivate' the index; unwatch db
  db.watch('/', function () {
    // TODO: update frontVersion
  })
}
inherits(Index, events.EventEmitter)

Index.prototype._run = function () {
  var self = this

  // get the current head version
  this._db.version(function (err, frontVersion) {
    if (err) return self.emit('error', err)
    self._getVersion(function (err, startVersion) {
      if (err) return self.emit('error', err)

      // If the hyperdb version matches what's in storage, the index is up to
      // date
      if (startVersion && frontVersion.equals(startVersion)) {
        self._indexRunning = false
        self.emit('ready')
      }

      var heads = startVersion ? versions.deserialize(startVersion) : null

      var source = self._db.createHistoryStream({start: startVersion, live: true})
      var sink = through.obj(write)
      pump(source, sink, onDone)

      function write (node, _, next) {
        self._indexRunning = true

        self._processFn(node, function (err) {
          if (err) return next(err)

          // Incrementally update the current 'version' using this node
          heads = updateHeadsWithNode(heads || [], node)
          var latestVersion = versions.serialize(heads)
          self._setVersion(latestVersion, next)

          // Compare this version to what hyperdb's true heads are; emit
          // 'ready' if they match
          self._db.version(function (err, headVersion) {
            if (err) return self.emit('error', err)
            if (latestVersion.equals(headVersion)) {
              self._indexRunning = false
              self.emit('ready')
            }
          })
        })
      }

      function onDone (err) {
        self.emit('error', err)
      }
    })
  })
}

Index.prototype.ready = function (cb) {
  if (!this._indexRunning) process.nextTick(cb)
  else this.once('ready', cb)
}

// [{key, seq}], Node -> [{key, seq}] <Mutate>
function updateHeadsWithNode (heads, node) {
  var newHeads = []

  if (!node.feeds.length) {
    heads[node.feed].seq = node.seq
    newHeads = heads
  } else {
    for (var i = 0; i < node.feeds.length; i++) {
      var feed = node.feeds[i]
      var match = false
      for (var j = 0; j < heads.length; j++) {
        var head = heads[j]
        if (feed.key.equals(head.key)) {
          match = true
          if (node.feed === i) {
            newHeads.push({ key: feed.key, seq: node.seq })
          } else {
            newHeads.push({ key: feed.key, seq: heads[j].seq })
          }
          break
        }
      }
      if (!match) {
        if (node.feed === i) {
          newHeads.push({ key: feed.key, seq: node.seq })
        } else {
          throw new Error('this should never happen')
        }
      }
    }
  }

  return newHeads
}
