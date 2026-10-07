#!/usr/bin/env python3
# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
"""CreaEditor: generates the Creacoon pet sprite sheets.

The Creacoon pet keeps the poses and timing of the original chat pet, but gets the Creacoon
look: the Creacoon asterisk as its antenna, brand-navy eyes and a soft highlight. It also gets
sheets for the agent activities (planning, reviewing, thinking and testing).

The source sprites are read from git (SOURCE_REVISION), so running the script twice gives the
same result. Usage, from the repository root:

    python3 scripts/creaeditor/chat-pet-sprites.py [--preview out.png]
"""

import argparse
import math
import io
import subprocess
from pathlib import Path

from PIL import Image

SPRITE_DIR = 'src/vs/workbench/contrib/chat/browser/widget/media/chatPet'
# The green and mint recolor of the original pet, before the Creacoon look.
SOURCE_REVISION = '4c9ef83eb7c'

# Body palettes per variant: shadow, mid, light, eye. 'stable' is green, 'insiders' is mint.
PALETTES = {
	'stable': {
		'shadow': (0x00, 0x77, 0x5a), 'mid': (0x00, 0xbd, 0x8b), 'light': (0x00, 0xec, 0x95),
		'highlight': (0x8c, 0xf7, 0xcc), 'eye': (0x1b, 0x1a, 0x36), 'heart': (0xff, 0x5c, 0x8a),
	},
	'insiders': {
		'shadow': (0x1b, 0x7a, 0x62), 'mid': (0x5c, 0xe0, 0xb4), 'light': (0xa6, 0xf9, 0xd6),
		'highlight': (0xe2, 0xfd, 0xf1), 'eye': (0x1b, 0x1a, 0x36), 'heart': (0xff, 0x5c, 0x8a),
	},
}
SOURCE_EYE = (0x19, 0x1a, 0x1b)

def read_source(name):
	data = subprocess.run(['git', 'show', f'{SOURCE_REVISION}:{SPRITE_DIR}/{name}'], capture_output=True, check=True).stdout
	return Image.open(io.BytesIO(data)).convert('RGBA')


def source_body_colors(variant):
	"""The body colors of the source sprites (the recolor before the Creacoon look)."""
	p = PALETTES[variant]
	if variant == 'stable':
		return {(0x00, 0x77, 0x5a), (0x00, 0xbd, 0x8b), (0x00, 0xec, 0x95)}
	return {(0xa6, 0xf9, 0xd6), (0x5c, 0xe0, 0xb4), (0x1b, 0x7a, 0x62), (0x2a, 0x8f, 0x74), p['light']}


def runs(row):
	"""Contiguous runs of True in a list, as (start, end) pairs."""
	result, start = [], None
	for x, v in enumerate(row + [False]):
		if v and start is None:
			start = x
		elif not v and start is not None:
			result.append((start, x))
			start = None
	return result


def find_apex(frame, body):
	"""The top of the head: the first row with a short body run directly above a wider one."""
	w, h = frame.size
	px = frame.load()
	mask = [[px[x, y][3] > 0 and px[x, y][:3] in body for x in range(w)] for y in range(h)]
	for y in range(h - 8):
		for (s, e) in runs(mask[y]):
			if e - s < 8 or e - s > 32:
				continue
			# The head widens row after row below its tip; music notes and sparkles don't.
			if y + 16 >= h:
				continue
			below = [r for r in runs(mask[y + 8]) if r[0] <= s and r[1] >= e and r[1] - r[0] >= e - s + 8]
			further = [r for r in runs(mask[y + 16]) if below and r[0] <= below[0][0] and r[1] >= below[0][1] and r[1] - r[0] >= e - s + 16]
			if below and further:
				return y, (s + e) // 2, mask
	return None


def component(mask, x, y, limit=None):
	"""The 4-connected pixels of the mask containing (x, y), or None when larger than limit."""
	h, w = len(mask), len(mask[0])
	seen = {(x, y)}
	stack = [(x, y)]
	while stack:
		cx, cy = stack.pop()
		for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
			if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and (nx, ny) not in seen:
				seen.add((nx, ny))
				if limit is not None and len(seen) > limit:
					return None
				stack.append((nx, ny))
	return seen


def recolor_eyes(frame, variant):
	px = frame.load()
	w, h = frame.size
	for y in range(h):
		for x in range(w):
			p = px[x, y]
			if p[3] and p[:3] == SOURCE_EYE:
				px[x, y] = PALETTES[variant]['eye'] + (p[3],)


def antenna_pixels(mask, cx, y0, w):
	"""The source antenna: body-colored pixels above the head tip, near its center."""
	return [(x, y) for y in range(0, y0) for x in range(max(0, cx - 56), min(w, cx + 56)) if mask[y][x]]


def is_heart(antenna, cx):
	"""Whether the source antenna is curled into a heart (wide and tall, as in the love animation)."""
	if not antenna:
		return False
	xs = [x for x, _ in antenna]
	ys = [y for _, y in antenna]
	return max(xs) - min(xs) >= 56 and max(ys) - min(ys) >= 28 and min(xs) < cx - 20 and max(xs) > cx + 20 and any(y > max(ys) - 16 and abs(x - cx) > 24 for x, y in antenna)


def fill(px, w, h, x, y, size, color):
	for dy in range(size):
		for dx in range(size):
			if 0 <= x + dx < w and 0 <= y + dy < h:
				px[x + dx, y + dy] = color + (255,)


# Extra transparent rows on top of every body frame, so the antenna fits the Creacoon mark.
# The widget adds the same headroom (CHAT_PET_HEADROOM) to the frame height and the accessory rig.
HEADROOM = 48
PIXEL = 8  # source pixels per pet pixel
ARM = 3  # pet pixels per arm of the mark, so the mark is 7x7 pet pixels

# The six arms of the Creacoon mark (degrees, counter-clockwise from the right) when the antenna
# is open, and where they fold to when it closes (the original antenna's arms meeting, as when
# clapping): the upper arms fold up onto the stalk, the lower ones down.
MARK_ARMS = [(90, 90), (0, 90), (45, 90), (180, 90), (225, 270), (270, 270)]
HEART = [
	'.x.x.',
	'xxxxx',
	'xxxxx',
	'.xxx.',
	'..x..',
]


def draw_shape(px, w, h, shape, left, top, color):
	for row, line in enumerate(shape):
		for col, c in enumerate(line):
			if c == 'x':
				fill(px, w, h, left + col * PIXEL, top + row * PIXEL, PIXEL, color)


def arm_pixels(angle, length):
	"""The pet pixels of an arm from the center, stepping along its major axis so that the
	horizontal, vertical and diagonal arms all have `length` pixels."""
	dx, dy = math.cos(math.radians(angle)), -math.sin(math.radians(angle))
	major = max(abs(dx), abs(dy))
	return [(round(k * dx / major), round(k * dy / major)) for k in range(1, length + 1)]


def draw_asterisk_antenna(frame, tip_x, y0, stalk, lean, spread, pal, heart=False):
	"""The Creacoon mark as the pet's antenna: a stalk from the head's tip with the mark on top.

	It follows the original antenna: `stalk` (pet pixels) stretches and squashes with the pet,
	`lean` (source pixels) sways the mark sideways and bends the stalk, and `spread` (0..1) opens
	and folds the mark's arms like the original antenna's arms. In the love pose it is a heart.
	"""
	px = frame.load()
	w, h = frame.size
	# The stalk bends at most one pet pixel per segment, so it stays connected to the mark.
	lean = max(-(stalk + 1) * PIXEL, min((stalk + 1) * PIXEL, lean))
	for i in range(1, stalk + 1):
		shift = round(lean * i / (stalk + 1) / 4) * 4
		fill(px, w, h, tip_x + shift, y0 - i * PIXEL, PIXEL, pal['mid'])
	center_x = tip_x + round(lean / 4) * 4
	center_y = y0 - (stalk + ARM + 1) * PIXEL
	if heart:
		draw_shape(px, w, h, HEART, center_x - 2 * PIXEL, center_y - PIXEL, pal['heart'])
		return
	fill(px, w, h, center_x, center_y, PIXEL, pal['light'])
	for open_angle, folded_angle in MARK_ARMS:
		angle = folded_angle + (open_angle - folded_angle) * spread
		for ax, ay in arm_pixels(angle, ARM):
			fill(px, w, h, center_x + ax * PIXEL, center_y + ay * PIXEL, PIXEL, pal['light'])


def creacoon_frame(frame, variant):
	"""Gives one frame the Creacoon look; frames without a recognizable head are only recolored."""
	frame = frame.copy()
	recolor_eyes(frame, variant)
	body = source_body_colors(variant)
	apex = find_apex(frame, body)
	if not apex:
		return frame
	y0, cx, mask = apex
	px = frame.load()
	w, h = frame.size
	pal = PALETTES[variant]
	antenna = antenna_pixels(mask, cx, y0, w)
	heart = is_heart(antenna, cx)
	# Remove the source antenna: body-colored pixels above the head near its center, and small
	# loose pieces beside the top of the head (a drooping antenna), which only touch it diagonally.
	head = component(mask, cx, y0)
	for y in range(0, min(h, y0 + 24)):
		for x in range(max(0, cx - 56), min(w, cx + 56)):
			if mask[y][x] and (y < y0 or (x, y) not in head):
				piece = component(mask, x, y, limit=400)
				if piece is not None and all(abs(px_x - cx) <= 56 and px_y < y0 + 24 for px_x, px_y in piece):
					for px_x, px_y in piece:
						px[px_x, px_y] = (0, 0, 0, 0)
						mask[px_y][px_x] = False
	# Follow the source antenna: its height gives the stalk length, its top row the sway, and
	# its width how far the arms are open (its two arms meet when it claps).
	if antenna and not heart:
		top = min(y for _, y in antenna)
		stalk = max(0, min(2, round((y0 - top) / PIXEL) - 2))
		top_xs = [x for x, y in antenna if y < top + PIXEL]
		lean = sum(top_xs) / len(top_xs) - cx
		widest = max(max(xs) - min(xs) for xs in ([x for x, y in antenna if y == row] for row in {y for _, y in antenna}) if xs)
		spread = max(0.0, min(1.0, (widest - 8) / 56))
	else:
		stalk, lean, spread = 1, 0, 1.0
	draw_asterisk_antenna(frame, cx - PIXEL // 2, y0, stalk, lean, spread, pal, heart)
	# A soft highlight on the lit side of the head, only where the body is plain light green.
	hx, hy = cx + 8, y0 + 16
	area = [(x, y) for x in range(hx, hx + 8) for y in range(hy, hy + 8)]
	if all(0 <= x < w and 0 <= y < h and px[x, y][3] and px[x, y][:3] == pal['light'] for x, y in area):
		for x, y in area:
			px[x, y] = pal['highlight'] + (255,)
	return frame


def pad(frame):
	"""Adds the headroom on top of a frame."""
	out = Image.new('RGBA', (frame.width, frame.height + HEADROOM))
	out.paste(frame, (0, HEADROOM))
	return out


def creacoon_sheet(sheet, frame_width, variant):
	out = Image.new('RGBA', (sheet.width, sheet.height + HEADROOM))
	for x in range(0, sheet.width, frame_width):
		frame = pad(sheet.crop((x, 0, x + frame_width, sheet.height)))
		out.paste(creacoon_frame(frame, variant), (x, 0))
	return out


# Frame width of every source animation; the static .png is one frame of the same size.
ANIMATIONS = {
	'clapping-{v}-tracking-96': 96, 'cool-{v}-96': 96, 'dizzy-{v}-128': 96, 'falling-{v}-96': 96,
	'idle-{v}-96': 96, 'idle-{v}-tracking-96': 96, 'jump-{v}-96': 96, 'love-{v}-96': 96,
	'press-button-{v}-96': 160, 'rendering-{v}-tracking-96': 96, 'respawn-{v}-96': 96,
	'search-{v}-96': 96, 'sing-{v}-124': 164, 'sleep-{v}-96': 120, 'speech-{v}-96': 96,
	'speechless-{v}-96': 96, 'splat-{v}-96': 96, 'typing-{v}-96': 168, 'waking-{v}-96': 120,
	'wall-impact-{v}-96': 96, 'worry-{v}-96': 96, 'yapping-{v}-96': 96,
}


# Overlay sheets without the pet's body (speech bubble, respawn sparkle), which keep their art and size.
HEADLESS = {'speech-{v}-96', 'respawn-{v}-96'}


def write_creacoon_look():
	"""Redraws every source animation, sheet and static frame, with the Creacoon look."""
	for pattern, frame_width in ANIMATIONS.items():
		if pattern in HEADLESS:
			continue
		for variant in PALETTES:
			name = 'buddy-' + pattern.format(v=variant)
			for suffix in ('.spritesheet.png', '.png'):
				try:
					source = read_source(name + suffix)
				except subprocess.CalledProcessError:
					continue  # e.g. wall-impact has no sheet
				creacoon_sheet(source, frame_width, variant).save(f'{SPRITE_DIR}/{name}{suffix}', optimize=True)


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument('--preview', help='only write a preview of a few frames to this file')
	args = parser.parse_args()
	if args.preview:
		tiles = []
		for variant in ('stable', 'insiders'):
			sheet = read_source(f'buddy-idle-{variant}-96.spritesheet.png')
			for f in (0, 25):
				tiles.append(creacoon_frame(pad(sheet.crop((f * 96, 0, f * 96 + 96, 96))), variant))
			tiles.append(pad(read_source(f'buddy-idle-{variant}-96.spritesheet.png').crop((0, 0, 96, 96))))
		preview = Image.new('RGBA', (len(tiles) * 106, 96 + HEADROOM), (27, 26, 54, 255))
		for i, t in enumerate(tiles):
			preview.paste(t, (i * 106, 0), t)
		preview.resize((preview.width * 3, preview.height * 3), Image.NEAREST).save(args.preview)
		return
	write_creacoon_look()


if __name__ == '__main__':
	main()
