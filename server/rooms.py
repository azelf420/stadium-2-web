# Room server for the online mode: pairs two pages by a room code and passes their WebRTC setup messages along, and
# their game packets too when a direct connection can't be made. It never sees the game, only the two players' messages.
# Python 3 standard library only (no packages to install on the host).
#
#   python3 server/rooms.py [--port 8787] [--origin https://example.github.io] [--origin http://127.0.0.1:8090]
#
# Messages are JSON text, as the page sends them (ports/stadium2/site/retro.html):
#   {t:'create'[, code][, name]} -> {t:'created', code}
#   {t:'join', code[, name]}     -> {t:'joined', code, host: <host's name>}, and {t:'peer-joined', name} to the host
#   {t:'kick'} (host)            -> {t:'kicked'} to the guest, who is out of the room, and {t:'peer-left', kicked} back
#   {t:'lock'} (host)            -> the game started: nobody else can join ({t:'error', msg:'in-game'})
#   anything else in a room goes to the other player as is; binary frames too (the relay for game packets).
import argparse
import asyncio
import base64
import hashlib
import json
import secrets
import struct

GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  # no 0/O, 1/I
MAX_MESSAGE = 64 * 1024
MAX_ROOMS = 500

rooms = {}  # code -> {'host': Peer, 'guest': Peer | None, 'locked': bool}


class Closed(Exception):
    pass


class Peer:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.room = None
        self.name = ''
        self.lock = asyncio.Lock()

    async def send(self, data):
        if isinstance(data, str):
            opcode, payload = 0x1, data.encode()
        else:
            opcode, payload = 0x2, bytes(data)
        n = len(payload)
        if n < 126:
            head = struct.pack('!BB', 0x80 | opcode, n)
        elif n < 65536:
            head = struct.pack('!BBH', 0x80 | opcode, 126, n)
        else:
            head = struct.pack('!BBQ', 0x80 | opcode, 127, n)
        async with self.lock:
            try:
                self.writer.write(head + payload)
                await self.writer.drain()
            except (ConnectionError, RuntimeError):
                pass

    async def send_json(self, obj):
        await self.send(json.dumps(obj))

    async def read_frame(self):
        b0, b1 = await self.reader.readexactly(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack('!H', await self.reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack('!Q', await self.reader.readexactly(8))[0]
        if n > MAX_MESSAGE or not b1 & 0x80:  # client frames must be masked
            raise Closed()
        mask = await self.reader.readexactly(4)
        data = bytearray(await self.reader.readexactly(n))
        for i in range(n):
            data[i] ^= mask[i & 3]
        return b0 & 0x80, b0 & 0x0F, bytes(data)

    async def messages(self):
        parts, kind = [], None
        while True:
            fin, opcode, data = await self.read_frame()
            if opcode == 0x8:
                raise Closed()
            if opcode == 0x9:
                async with self.lock:
                    self.writer.write(struct.pack('!BB', 0x8A, len(data)) + data)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                parts, kind = [data], opcode
            elif opcode == 0x0 and kind is not None:
                parts.append(data)
            else:
                raise Closed()
            if sum(len(p) for p in parts) > MAX_MESSAGE:
                raise Closed()
            if fin:
                message = b''.join(parts)
                yield message.decode() if kind == 0x1 else message
                parts, kind = [], None


def clean_name(value):
    name = ''.join(c for c in str(value or '') if c.isprintable() and c not in '<>&"')
    return name.strip()[:12]


def other(peer):
    room = rooms.get(peer.room)
    if not room:
        return None
    return room['guest'] if room['host'] is peer else room['host']


async def on_message(peer, message):
    if isinstance(message, bytes):
        target = other(peer)
        if target:
            await target.send(message)
        return
    try:
        msg = json.loads(message)
    except ValueError:
        return
    kind = msg.get('t') if isinstance(msg, dict) else None
    if kind == 'create' and peer.room is None:
        if len(rooms) >= MAX_ROOMS:
            return await peer.send_json({'t': 'error', 'msg': 'full'})
        code = str(msg.get('code') or '').upper()
        if not (len(code) == 4 and all(c in CODE_LETTERS for c in code)) or code in rooms:
            code = ''.join(secrets.choice(CODE_LETTERS) for _ in range(4))
            while code in rooms:
                code = ''.join(secrets.choice(CODE_LETTERS) for _ in range(4))
        rooms[code] = {'host': peer, 'guest': None, 'locked': False}
        peer.room = code
        peer.name = clean_name(msg.get('name'))
        await peer.send_json({'t': 'created', 'code': code})
    elif kind == 'join' and peer.room is None:
        code = str(msg.get('code') or '').upper()
        room = rooms.get(code)
        if not room:
            return await peer.send_json({'t': 'error', 'msg': 'no-room'})
        if room['locked']:
            return await peer.send_json({'t': 'error', 'msg': 'in-game'})
        if room['guest']:
            return await peer.send_json({'t': 'error', 'msg': 'room-full'})
        room['guest'] = peer
        peer.room = code
        peer.name = clean_name(msg.get('name'))
        await peer.send_json({'t': 'joined', 'code': code, 'host': room['host'].name})
        await room['host'].send_json({'t': 'peer-joined', 'name': peer.name})
    elif kind == 'kick' and peer.room is not None:
        room = rooms.get(peer.room)
        if room and room['host'] is peer and room['guest']:
            guest = room['guest']
            room['guest'] = None
            guest.room = None
            await guest.send_json({'t': 'kicked'})
            await peer.send_json({'t': 'peer-left', 'kicked': True})
    elif kind == 'lock' and peer.room is not None:
        room = rooms.get(peer.room)
        if room and room['host'] is peer:
            room['locked'] = True
    elif peer.room is not None:
        target = other(peer)
        if target:
            await target.send(message)


async def leave(peer):
    room = rooms.get(peer.room)
    if not room:
        return
    if room['host'] is peer:
        del rooms[peer.room]
        if room['guest']:
            room['guest'].room = None
            await room['guest'].send_json({'t': 'peer-left'})
    else:
        room['guest'] = None
        await room['host'].send_json({'t': 'peer-left'})


def make_handler(origins):
    async def handle(reader, writer):
        peer = Peer(reader, writer)
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
            lines = head.decode('latin-1').split('\r\n')
            method, path = (lines[0].split(' ') + ['', ''])[:2]
            headers = {}
            for line in lines[1:]:
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
            key = headers.get('sec-websocket-key', '')
            ok = (method == 'GET' and path.split('?')[0] == '/signal' and key and
                  'websocket' in headers.get('upgrade', '').lower() and
                  (not origins or headers.get('origin', '') in origins))
            if not ok:
                writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                await writer.drain()
                return
            accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                          f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())
            await writer.drain()
            async for message in peer.messages():
                await on_message(peer, message)
        except (Closed, asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError,
                ConnectionError, UnicodeDecodeError):
            pass
        finally:
            await leave(peer)
            writer.close()
    return handle


async def main():
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8787)
    p.add_argument('--origin', action='append', default=[], help='allowed page origin (any if none given)')
    a = p.parse_args()
    server = await asyncio.start_server(make_handler(set(a.origin)), a.host, a.port)
    print(f'room server on {a.host}:{a.port}, origins: {a.origin or "any"}', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
