var EventEmitter = require('events').EventEmitter
var L = require('lodash')
var ES = require('event-stream')
var asMessageStream = require('./as-message-stream')

exports.Hub = Hub
exports.Client = Client
exports.VirtualClient = VirtualClient


function Hub (server, opts) {
    if(! (this instanceof Hub))
        return new Hub(server)

    EventEmitter.call(this)

    if(opts == null) opts = {}

    this.name = opts.name || 'hub'

    this.server = server
    this.peers = []
    this.idCount = 1
    this.listeners = Object.create(null)

    initHub(this)
}

Hub.prototype.__proto__ = EventEmitter.prototype;

function initHub (hub) {
    if(hub.server != null) {
        hub.server.on('connection', function (conn) {
            peerFromConnection(conn)
        })
    }

    hub.peerFromConnection = peerFromConnection
    hub.peerFromObjStream = peerFromObjStream

    function peerFromConnection (conn) {
        var peerId = hub.idCount ++

        hub.emit('log', ['connection', peerId])

        var messages = asMessageStream(conn)

        messages.on('error', function (err) {
            hub.emit('error', err)
        })

        peerFromObjStream(messages, peerId)

        conn.on('close', function () {
            hub.emit('log', ['close', peerId])

            removePeer(peerId)
            sendPeers()
        })
    }

    function peerFromObjStream (messages, peerId) {
        if(peerId == null) peerId = hub.idCount ++

        messages.once('data', function (hello) {
            try {
                if(hello[0] != 'hello')
                    throw new Error('invalid peer')

                var peer = {
                    id: peerId,
                    name: hello[1].name,
                    attributes: hello[1].attributes,
                    messages: messages,
                    since: Date.now(),
                }

                hub.peers.push(peer)

                messages.on('data', function (obj) {
                    handleMessage(peer, obj)
                })

                messages.write(['joined', { id: peer.id }])
                hub.emit('log', ['peer', peer.id, peer.name, peer.attributes])

                sendPeers()
            }
            catch (err) {
                messages.end(['invalid'])
                hub.emit('error', err)
            }
        })

        messages.write(['hello'])
    }

    function removePeer (peerId) {
        L.remove(hub.peers, { id: peerId })
        L.each(hub.listeners, function (list, key) {
            L.remove(list, { id: peerId })
        })
    }

    function handleMessage (peer, msg) {
        try {
            if(! Array.isArray(msg) || typeof msg[0] != 'string') {
                throw new Error('invalid message')
            }

            hub.emit('log', ['<-', peer.id, peer.name].concat(msg))

            if(msg[0] == 'subscribe' && msg[1] != null) {
                addListener(msg[1], peer)
                return
            }

            if(msg[0] == 'unsubscribe' && msg[1] != null) {
                removeListener(msg[1], peer)
                return
            }

            if(msg[0] == 'event' && msg[1] != null) {
                sendEvent(peer, msg[1], msg[2])
                return
            }

            if(msg[0] == 'message-to' && msg[1] != null && msg[2] != null) {
                var targetId = msg[1]
                var target = L.find(hub.peers, function (peer) { return peer.id == targetId })
                if(target != null)
                    sendMessageFrom(target, peer, msg[2])
                return
            }

            throw new Error('invalid message')
        }
        catch (err) {
            hub.emit('error', err)
        }
    }

    function sendPeers () {
        if(hub._peerUpdateTimeout) clearTimeout(hub._peerUpdateTimeout)

        hub._peerUpdateTimeout = setTimeout(function () {
            L.each(hub.peers, function (peer) {
                peer.messages.write(['peers',
                    L.map(hub.peers, function (peer) {
                        return  L.pick(peer, ['id', 'name', 'attributes', 'since']) }) ])
            })
        }, 100)
    }

    function addListener (ev, peer) {
        if(hub.listeners[ev] == null)
            hub.listeners[ev] = []

        if(! L.contains(hub.listeners[ev], peer))
            hub.listeners[ev].push(peer)
    }

    function removeListener (ev, peer) {
        if(hub.listeners[ev] != null)
            L.remove(hub.listeners, peer)
    }

    function sendEvent (from, ev, val) {
        if(hub.listeners[ev] != null) {
            L.each(hub.listeners[ev], function (peer) {
                if(peer != from)
                    peer.messages.write(['event', from.id, ev, val])
            })
        }
    }

    function sendMessageFrom (target, from, message) {
        target.messages.write(['message-from', from.id, message])
    }
}


function Client (stream, opts) {
    if(! (this instanceof Client))
        return new Client(stream, name, opts)

    EventEmitter.call(this)

    if(!opts) opts = {}

    this.stream = stream

    this.name = opts.name || 'peer'
    this.attributes = opts.attributes != null ? opts.attributes : {}

    this.attributes.origin = {
        host: require('os').hostname().replace(/\.local$/, ''),
        pid: process.pid,
    }

    this.id = null
    this.peers = null

    this.objMode = opts.objMode

    this.listeners = Object.create(null)
    this.cbs = Object.create(null)
    this.cbCount = 1

    initClient(this)
}

Client.prototype.__proto__ = EventEmitter.prototype;

function initClient (me) {
    var messages = me.objMode ? me.stream : asMessageStream(me.stream)

    messages.on('data', function (obj) { handleMessage(obj) })
    messages.on('error', function (err) { me.emit('error', err) })

    var queue = ES.through()
    queue.pipe(messages)
    queue.pause()

    var active = false

    function setActive () {
        if(active) return

        active = true
        queue.resume()

        me.emit('joined')
        me.emit('log', ['joined'])
    }

    function setInactive () {
        if(! active) return

        active = false
        queue.pause()

        L.each(me.listeners, function (_, event) {
            queue.write(['subscribe', event])
        })

        me.id = null
        me.peers = null

        me.emit('dropped')
        me.emit('log', ['dropped'])
    }

    me.stream.on('close', function () {
        setInactive()
    })

    me.on('newListener', function (ev) {
        ev = getEventName(ev)

        if(ev == null)
            return

        if(me.listeners[ev] != null && me.listeners[ev] > 0) {
            me.listeners[ev] += 1
        }
        else {
            me.listeners[ev] = 1
            subscribe(ev)
        }
    })

    me.on('removeListener', function (ev) {
        ev = getEventName(ev)

        if(ev == null)
            return

        if(me.listeners[ev] != null) {
            me.listeners[ev] -= 1

            if(me.listeners[ev] <= 0) {
                unsubscribe(ev)
                delete me.listeners[ev]
            }
        }
    })

    function getEventName (name) {
        var match = /^cast:(\w+)$/.exec(name)
        return match && match[1]
    }

    function subscribe (event) {
        queue.write(['subscribe', event])
    }

    function unsubscribe (event) {
        queue.write(['unsubscribe', event])
    }

    me.sendEvent = function (event, params) {
        me.emit('log', ['->', 'event', event])
        queue.write(['event', event, params])
    }

    me.sendTo = function (peer, params) {
        peer = getPeerId(peer)
        me.emit('log', ['->', 'message-to', peer])
        queue.write(['message-to', peer, params])
    }

    me.requestTo = function (peer, params, cb) {
        peer = getPeerId(peer)

        if(typeof cb != 'function') throw new Error('invalid callback')

        var reqId = me.cbCount ++
        me.cbs[reqId] = cb

        me.emit('log', ['->', 'request-to', peer])
        queue.write(['message-to', peer, {'?rpc': 'request', id: reqId, request: params}])
    }

    function getPeerId (peer) {
        if(typeof peer == 'object') peer = peer.id
        if(typeof peer != 'number') throw new Error('invalid peer ' + peer)
        return peer
    }

    function getPeer (peer) {
        if(typeof peer == 'object') return peer
        return L.find(me.peers, function (it) { return it.id == peer })
    }

    me.close = function () {
        me.stream.end()
    }

    function handleMessage (msg) {
        try {
            if(! Array.isArray(msg) || typeof msg[0] != 'string') {
                throw new Error('invalid message')
            }

            me.emit('log', ['<-'].concat(msg))

            if(msg[0] == 'hello') {
                messages.write(['hello',
                    { name: me.name, attributes: me.attributes } ])
                return
            }

            if(msg[0] == 'invalid') {
                me.emit('error', new Error('invalid reponse'))
                return
            }

            if(msg[0] == 'joined') {
                if(me.id != null)
                    throw new Error('duplicate join')

                me.id = msg[1].id
                setActive()

                return
            }

            if(msg[0] == 'peers') {
                me.peers = msg[1]
                me.emit('peers', me.peers)
                return
            }

            if(msg[0] == 'event') {
                var from = msg[1], ev = msg[2], body = msg[3]
                me.emit('cast:' + ev, {from: getPeer(from), message: body})
                return
            }

            if(msg[0] == 'message-from') {
                var from = msg[1], body = msg[2]

                if(body['?rpc'] == 'request') {
                    var sent = false
                    me.emit('request', {
                        from: getPeer(from),
                        request: body.request,
                        respond: function (response) {
                            if(sent) return
                            sent = true
                            me.sendTo(from, {'?rpc': 'response', id: body.id, response: response})
                        },
                    })
                    return
                }

                if(body['?rpc'] == 'response') {
                    me.cbs[body.id]({from: from, response: body.response})
                    delete me.cbs[body.id]
                    return
                }

                me.emit('message', getPeer(from), body)
                return
            }

            throw new Error('invalid message')
        }
        catch(err) {
            me.emit('error', err)
        }
    }
}

function VirtualClient (hub, opts) {
    if(opts == null) opts = {}
    opts.objMode = true

    var clientIncoming = ES.through()
    var clientOutgoing = ES.through()

    clientIncoming.pause()
    setTimeout(function () { clientIncoming.resume() })

    var client = new Client(ES.duplex(clientOutgoing, clientIncoming), opts)

    hub.peerFromObjStream(ES.duplex(clientIncoming, clientOutgoing))

    return client
}
