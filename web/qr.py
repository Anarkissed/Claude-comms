"""A small QR code encoder (byte mode, error correction M, versions 1-6: up to 106 bytes).

Standard library only. It follows ISO/IEC 18004 the way Project Nayuki's reference
encoder lays it out: data and Reed-Solomon codewords, finder/timing/alignment
patterns, the eight masks scored by the four penalty rules, and the format bits.

    matrix = encode("http://192.168.1.20:8765/phone?c=ABC234")   # rows of bools, True = dark
    print(terminal(matrix))                                     # coloured cells, dark on white
"""

from typing import List

# Error correction M, versions 1..6: (ec codewords per block, number of blocks, data codewords per block)
_BLOCKS = {1: (10, 1, 16), 2: (16, 1, 28), 3: (26, 1, 44), 4: (18, 2, 32), 5: (24, 2, 43), 6: (16, 4, 27)}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}
_ECL_M_BITS = 0  # format bits for level M

# GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1
_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _rs_generator(degree: int) -> List[int]:
    """Coefficients of prod (x - a^i), i < degree, highest power first, leading 1 dropped."""
    poly = [1]
    for i in range(degree):
        nxt = [0] * (len(poly) + 1)
        for j, c in enumerate(poly):
            nxt[j] ^= c
            nxt[j + 1] ^= _mul(c, _EXP[i])
        poly = nxt
    return poly[1:]


def _rs_remainder(data: List[int], degree: int) -> List[int]:
    gen = _rs_generator(degree)
    rem = [0] * degree
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        for k in range(degree):
            rem[k] ^= _mul(gen[k], factor)
    return rem


def _capacity(version: int) -> int:
    ec, blocks, data = _BLOCKS[version]
    return (blocks * data * 8 - 4 - 8) // 8  # byte mode: 4 mode bits, 8 count bits (versions 1-9)


def _codewords(payload: bytes, version: int) -> List[int]:
    ec, blocks, per_block = _BLOCKS[version]
    total_data = blocks * per_block
    bits: List[int] = []

    def put(value: int, length: int) -> None:
        bits.extend((value >> (length - 1 - i)) & 1 for i in range(length))

    put(0b0100, 4)
    put(len(payload), 8)
    for b in payload:
        put(b, 8)
    put(0, min(4, total_data * 8 - len(bits)))
    put(0, (8 - len(bits) % 8) % 8)
    data = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < total_data:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    split = [data[i * per_block:(i + 1) * per_block] for i in range(blocks)]
    ecc = [_rs_remainder(block, ec) for block in split]
    out = [split[b][i] for i in range(per_block) for b in range(blocks)]
    out += [ecc[b][i] for i in range(ec) for b in range(blocks)]
    return out


def _format_bits(mask: int) -> int:
    data = (_ECL_M_BITS << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return ((data << 10) | rem) ^ 0x5412


_MASKS = [
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: y % 2 == 0,
    lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0,
    lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0,
    lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
]


class _Grid:
    def __init__(self, version: int) -> None:
        self.size = version * 4 + 17
        self.dark = [[False] * self.size for _ in range(self.size)]
        self.fixed = [[False] * self.size for _ in range(self.size)]
        self.version = version

    def set(self, x: int, y: int, dark: bool) -> None:
        self.dark[y][x] = dark
        self.fixed[y][x] = True

    def function_patterns(self) -> None:
        n = self.size
        for i in range(n):
            self.set(6, i, i % 2 == 0)
            self.set(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < n and 0 <= y < n:
                        self.set(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        centers = _ALIGN[self.version]
        for i, ax in enumerate(centers):
            for j, ay in enumerate(centers):
                corner = (i == 0 and j == 0) or (i == 0 and j == len(centers) - 1) or (i == len(centers) - 1 and j == 0)
                if corner:
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
        self.format(0)  # reserve the format areas; drawn for real once the mask is chosen

    def format(self, mask: int) -> None:
        n, bits = self.size, _format_bits(mask)
        bit = lambda i: (bits >> i) & 1 == 1  # noqa: E731
        for i in range(6):
            self.set(8, i, bit(i))
        self.set(8, 7, bit(6))
        self.set(8, 8, bit(7))
        self.set(7, 8, bit(8))
        for i in range(9, 15):
            self.set(14 - i, 8, bit(i))
        for i in range(8):
            self.set(n - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.set(8, n - 15 + i, bit(i))
        self.set(8, n - 8, True)  # the dark module

    def codewords(self, data: List[int]) -> None:
        n, i, right = self.size, 0, self.size - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = n - 1 - vert if upward else vert
                    if not self.fixed[y][x] and i < len(data) * 8:
                        self.dark[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1 == 1
                        i += 1
            right -= 2

    def apply_mask(self, mask: int) -> None:
        cond = _MASKS[mask]
        for y in range(self.size):
            for x in range(self.size):
                if not self.fixed[y][x] and cond(x, y):
                    self.dark[y][x] = not self.dark[y][x]

    def penalty(self) -> int:
        n, d, score = self.size, self.dark, 0
        lines = [row for row in d] + [[d[y][x] for y in range(n)] for x in range(n)]
        for line in lines:  # rule 1: runs of five or more
            run, prev = 0, None
            for v in line:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + run - 5
                    run, prev = 1, v
            if run >= 5:
                score += 3 + run - 5
        for y in range(n - 1):  # rule 2: 2x2 blocks
            for x in range(n - 1):
                if d[y][x] == d[y][x + 1] == d[y + 1][x] == d[y + 1][x + 1]:
                    score += 3
        a = [True, False, True, True, True, False, True, False, False, False, False]
        b = list(reversed(a))
        for line in lines:  # rule 3: finder-like patterns
            for i in range(n - 10):
                window = line[i:i + 11]
                if window == a or window == b:
                    score += 40
        dark = sum(v for row in d for v in row)  # rule 4: balance of dark and light
        total = n * n
        score += ((abs(dark * 20 - total * 10) + total - 1) // total - 1) * 10
        return score


def encode(text: str) -> List[List[bool]]:
    payload = text.encode("utf-8")
    version = next((v for v in range(1, 7) if _capacity(v) >= len(payload)), None)
    if version is None:
        raise ValueError(f"too long for a QR code here ({len(payload)} bytes, at most {_capacity(6)})")
    data = _codewords(payload, version)
    best = None
    for mask in range(8):
        grid = _Grid(version)
        grid.function_patterns()
        grid.codewords(data)
        grid.apply_mask(mask)
        grid.format(mask)
        score = grid.penalty()
        if best is None or score < best[0]:
            best = (score, grid)
    return best[1].dark


def terminal(matrix: List[List[bool]], quiet: int = 3) -> str:
    """One text line per module row, each module two spaces painted with a background
    colour: black for dark, bright white for light. Background fills the whole character
    cell, line spacing included, so the squares stay solid and even in any font, where
    half-block glyphs leave light seams between lines that scanners cannot read."""
    n = len(matrix)
    size = n + 2 * quiet
    dark, light, reset = "\033[40m", "\033[107m", "\033[0m"
    out = []
    for y in range(size):
        row, last = [], None
        for x in range(size):
            is_dark = 0 <= x - quiet < n and 0 <= y - quiet < n and matrix[y - quiet][x - quiet]
            colour = dark if is_dark else light
            if colour != last:
                row.append(colour)
                last = colour
            row.append("  ")
        out.append("".join(row) + reset)
    return "\n".join(out)


def rows(matrix: List[List[bool]]) -> List[str]:
    """The matrix as strings of 0/1, for the page to draw."""
    return ["".join("1" if v else "0" for v in row) for row in matrix]


def png(matrix: List[List[bool]], scale: int = 10, quiet: int = 4) -> bytes:
    """A black-on-white PNG (grayscale), for checking a code with a real decoder."""
    import struct
    import zlib

    n = len(matrix)
    size = (n + 2 * quiet) * scale
    raw = bytearray()
    for py in range(size):
        raw.append(0)
        y = py // scale - quiet
        for px in range(size):
            x = px // scale - quiet
            raw.append(0 if 0 <= x < n and 0 <= y < n and matrix[y][x] else 255)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b"")
