var ES = require('event-stream')
var AMP = require('amp')

module.exports = function asMessageStream (stream) {
    var incoming = ES.through()

    var parser =
        new AMP.Stream()
        .on('data', function (d) {
            try { var obj = JSON.parse(AMP.decode(d)[0]) }
            catch (err) { incoming.emit('error', err); return }
            incoming.write(obj)
        })
        .on('error', function (err) { incoming.emit('error', err) })

    var outgoing = ES.through(function (obj) {
        stream.write(AMP.encode([Buffer(JSON.stringify(obj))]))
    })

    var duplex = ES.duplex(outgoing, incoming)

    stream.on('data', function (d) { parser.write(d) })
    stream.on('error', function (err) { duplex.emit('error', new Error("Message stream error: " + err.message)) })

    return duplex
}
