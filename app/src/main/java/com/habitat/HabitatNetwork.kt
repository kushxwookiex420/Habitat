package com.habitat

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SNIHostName

object HabitatNetwork {
    private const val HABITAT_HOST = "habitat-1-szzd.onrender.com"
    private const val DNS_PORT = 53
    private val DNS_SERVERS = listOf("1.1.1.1", "8.8.8.8")

    fun openConnection(urlString: String): HttpsURLConnection {
        val url = URL(urlString)
        if (!url.protocol.equals("https", ignoreCase = true) ||
            !url.host.equals(HABITAT_HOST, ignoreCase = true)
        ) return url.openConnection() as HttpsURLConnection

        return try {
            InetAddress.getAllByName(HABITAT_HOST)
            url.openConnection() as HttpsURLConnection
        } catch (_: UnknownHostException) {
            val ip = resolveIpv4(HABITAT_HOST)
                ?: throw UnknownHostException("$HABITAT_HOST (system DNS and direct DNS fallback both failed)")
            val ipUrl = URL("https://" + ip + url.file)
            val connection = ipUrl.openConnection() as HttpsURLConnection
            try { connection.setRequestProperty("Host", HABITAT_HOST) } catch (_: Exception) {}
            connection.sslSocketFactory = SniSocketFactory(HABITAT_HOST, ip)
            connection.hostnameVerifier = HostnameVerifierFor(HABITAT_HOST)
            connection
        }
    }

    private fun resolveIpv4(hostname: String): String? {
        for (server in DNS_SERVERS) {
            try {
                val packet = buildQuery(hostname)
                DatagramSocket().use { socket ->
                    socket.soTimeout = 1800
                    socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName(server), DNS_PORT))
                    val buffer = ByteArray(2048)
                    val response = DatagramPacket(buffer, buffer.size)
                    socket.receive(response)
                    parseFirstIpv4(response.data, response.length)?.let { return it }
                }
            } catch (_: Exception) {}
        }
        return null
    }

    private fun buildQuery(hostname: String): ByteArray {
        val out = ByteArray(512)
        val b = ByteBuffer.wrap(out).order(ByteOrder.BIG_ENDIAN)
        b.putShort(0x4A21.toShort()); b.putShort(0x0100.toShort())
        b.putShort(1); b.putShort(0); b.putShort(0); b.putShort(0)
        for (label in hostname.split(".")) {
            val bytes = label.toByteArray(Charsets.US_ASCII)
            b.put(bytes.size.toByte()); b.put(bytes)
        }
        b.put(0); b.putShort(1); b.putShort(1)
        return out.copyOf(b.position())
    }

    private fun parseFirstIpv4(data: ByteArray, length: Int): String? {
        if (length < 12) return null
        val flags = u16(data, 2)
        if ((flags and 0x8000) == 0 || (flags and 0x000F) != 0) return null
        val qd = u16(data, 4); val an = u16(data, 6)
        var pos = 12
        repeat(qd) {
            pos = skipName(data, pos, length) ?: return null
            if (pos + 4 > length) return null
            pos += 4
        }
        repeat(an) {
            pos = skipName(data, pos, length) ?: return null
            if (pos + 10 > length) return null
            val type = u16(data, pos); val clazz = u16(data, pos + 2)
            val rdLength = u16(data, pos + 8); pos += 10
            if (pos + rdLength > length) return null
            if (type == 1 && clazz == 1 && rdLength == 4) {
                return (data[pos].toInt() and 255).toString() + "." +
                    (data[pos + 1].toInt() and 255) + "." +
                    (data[pos + 2].toInt() and 255) + "." +
                    (data[pos + 3].toInt() and 255)
            }
            pos += rdLength
        }
        return null
    }

    private fun skipName(data: ByteArray, start: Int, length: Int): Int? {
        var pos = start
        while (pos < length) {
            val size = data[pos].toInt() and 255
            if (size == 0) return pos + 1
            if ((size and 0xC0) == 0xC0) return if (pos + 1 < length) pos + 2 else null
            if ((size and 0xC0) != 0 || pos + 1 + size > length) return null
            pos += 1 + size
        }
        return null
    }

    private fun u16(data: ByteArray, offset: Int): Int =
        ((data[offset].toInt() and 255) shl 8) or (data[offset + 1].toInt() and 255)

    private class HostnameVerifierFor(private val expectedHost: String) : javax.net.ssl.HostnameVerifier {
        private val delegate = HttpsURLConnection.getDefaultHostnameVerifier()
        override fun verify(hostname: String, session: SSLSession): Boolean = delegate.verify(expectedHost, session)
    }

    private class SniSocketFactory(
        private val expectedHost: String,
        private val ip: String
    ) : SSLSocketFactory() {
        private val delegate = SSLContext.getDefault().socketFactory
        private fun configure(socket: Socket): Socket {
            if (socket is SSLSocket) {
                val params = socket.sslParameters
                params.serverNames = listOf(SNIHostName(expectedHost))
                socket.sslParameters = params
            }
            return socket
        }
        override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
            configure(delegate.createSocket(s, expectedHost, port, autoClose))
        override fun createSocket(host: String, port: Int): Socket {
            val plain = Socket(); plain.connect(InetSocketAddress(ip, port), 15000)
            return configure(delegate.createSocket(plain, expectedHost, port, true))
        }
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket {
            val plain = Socket(); plain.bind(InetSocketAddress(localHost, localPort))
            plain.connect(InetSocketAddress(ip, port), 15000)
            return configure(delegate.createSocket(plain, expectedHost, port, true))
        }
        override fun createSocket(address: InetAddress, port: Int): Socket {
            val plain = Socket(); plain.connect(InetSocketAddress(ip, port), 15000)
            return configure(delegate.createSocket(plain, expectedHost, port, true))
        }
        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket {
            val plain = Socket(); plain.bind(InetSocketAddress(localAddress, localPort))
            plain.connect(InetSocketAddress(ip, port), 15000)
            return configure(delegate.createSocket(plain, expectedHost, port, true))
        }
        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites
    }
}
