#version 300 es
precision mediump float;

/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const float PI = 3.141592653589793;

in vec2 in_uv;
uniform sampler2D in_texture;
uniform vec2 in_resolution;

uniform sampler2D u_watermark;
uniform vec2 u_wmResolution;

uniform float u_opacity;
uniform float u_scale;
uniform float u_angle;
uniform bool u_cover;
uniform bool u_repeat;
uniform int u_alignX;
uniform int u_alignY;
uniform float u_margin;
uniform float u_repeatMargin;
uniform bool u_noBBoxExpansion;
uniform bool u_wmEnabled;

out vec4 out_color;

mat2 rot(float a) {
	float c = cos(a), s = sin(a);
	return mat2(c, -s, s, c);
}

vec2 computeWmSize(vec2 outSize, vec2 wmSize, bool cover, float scale) {
	float wmAspect = wmSize.x / wmSize.y;
	float outAspect = outSize.x / outSize.y;
	vec2 size;
	if (cover) {
		if (wmAspect >= outAspect) {
			size.y = outSize.y * scale;
			size.x = size.y * wmAspect;
		} else {
			size.x = outSize.x * scale;
			size.y = size.x / wmAspect;
		}
	} else {
		if (wmAspect >= outAspect) {
			size.x = outSize.x * scale;
			size.y = size.x / wmAspect;
		} else {
			size.y = outSize.y * scale;
			size.x = size.y * wmAspect;
		}
	}
	return size;
}

void main() {
	vec2 outSize = in_resolution;
	vec2 p = in_uv * outSize;
	vec4 base = texture(in_texture, in_uv);

	if (!u_wmEnabled) {
		out_color = base;
		return;
	}

	float theta = u_angle * PI;
	vec2 wmSize = computeWmSize(outSize, u_wmResolution, u_cover, u_scale);
	vec2 margin = u_repeat ? wmSize * u_repeatMargin : outSize * u_margin;

	float rotateX = 0.0;
	float rotateY = 0.0;
	if (abs(theta) > 1e-6 && !u_noBBoxExpansion) {
		rotateX = abs(abs(wmSize.x * cos(theta)) + abs(wmSize.y * sin(theta)) - wmSize.x) * 0.5;
		rotateY = abs(abs(wmSize.x * sin(theta)) + abs(wmSize.y * cos(theta)) - wmSize.y) * 0.5;
	}

	float x;
	if (u_alignX == 1) {
		x = (outSize.x - wmSize.x) * 0.5;
	} else if (u_alignX == 0) {
		x = rotateX + margin.x;
	} else {
		x = outSize.x - wmSize.x - margin.x - rotateX;
	}

	float y;
	if (u_alignY == 1) {
		y = (outSize.y - wmSize.y) * 0.5;
	} else if (u_alignY == 0) {
		y = rotateY + margin.y;
	} else {
		y = outSize.y - wmSize.y - margin.y - rotateY;
	}

	vec2 rectMin = vec2(x, y);
	vec2 rectMax = rectMin + wmSize;
	vec2 rectCenter = (rectMin + rectMax) * 0.5;

	vec4 wmCol = vec4(0.0);

	if (u_repeat) {

		vec2 q = rectCenter + rot(theta) * (p - rectCenter);

		vec2 gridOrigin = rectMin - margin;
		vec2 qFromOrigin = q - gridOrigin;

		vec2 tile = wmSize + margin * 2.0;
		vec2 tileUv = qFromOrigin / tile;

		vec2 localUv = fract(tileUv);

		vec2 localPos = localUv * tile;

		bool inMargin = any(lessThan(localPos, margin)) || any(greaterThanEqual(localPos, margin + wmSize));

		if (!inMargin) {

			vec2 uvWm = (localPos - margin) / wmSize;
			wmCol = texture(u_watermark, uvWm);
		}

	} else {

		vec2 q = rectCenter + rot(theta) * (p - rectCenter);
		bool inside = all(greaterThanEqual(q, rectMin)) && all(lessThan(q, rectMax));
		if (inside) {
			vec2 uvWm = (q - rectMin) / wmSize;
			wmCol = texture(u_watermark, uvWm);
		}
	}

	float a = clamp(wmCol.a * u_opacity, 0.0, 1.0);
	out_color = mix(base, vec4(wmCol.rgb, 1.0), a);
}
