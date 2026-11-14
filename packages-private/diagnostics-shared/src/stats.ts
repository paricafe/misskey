/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function median(values: number[]) {
	const sorted = values.toSorted((a, b) => a - b);
	const center = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[center];
	return Math.round((sorted[center - 1] + sorted[center]) / 2);
}

export function mad(values: number[]) {
	if (values.length < 2) throw new Error('Not enough samples to calculate MAD');

	const center = median(values);
	return median(values.map(value => Math.abs(value - center)));
}

export function finiteMedian(values: (number | null | undefined)[]): number | null;
export function finiteMedian(values: (number | null | undefined)[], defaultValue: number): number;
export function finiteMedian(values: (number | null | undefined)[], defaultValue: number | null = null) {
	const finiteValues = values.filter(value => Number.isFinite(value)) as number[];
	if (finiteValues.length === 0) return defaultValue;
	return median(finiteValues);
}

export function sampleSpread(values: (number | null | undefined)[]) {
	const finiteValues = values.filter(value => Number.isFinite(value)) as number[];
	if (finiteValues.length < 2) return null;
	return mad(finiteValues);
}

export type IndependentDeltaSummary = {
	baseMedian: number;
	headMedian: number;
	delta: number;
	baseMad: number;
	headMad: number;
	combinedMad: number;
	baseSamples: number;
	headSamples: number;
};

export function independentDeltaSummary<T>(
	baseSamples: T[],
	headSamples: T[],
	getValue: (sample: T) => number,
): IndependentDeltaSummary {
	const baseValues = baseSamples.map(getValue);
	const headValues = headSamples.map(getValue);
	if (baseValues.length < 2 || headValues.length < 2) {
		throw new Error('At least two samples per side are required');
	}

	const baseMedian = median(baseValues);
	const headMedian = median(headValues);
	const baseMad = mad(baseValues);
	const headMad = mad(headValues);

	return {
		baseMedian,
		headMedian,
		delta: headMedian - baseMedian,
		baseMad,
		headMad,
		combinedMad: Math.hypot(baseMad, headMad),
		baseSamples: baseValues.length,
		headSamples: headValues.length,
	};
}

export function isOutsideObservedNoise(summary: IndependentDeltaSummary) {
	return Math.abs(summary.delta) > summary.combinedMad * 3;
}

type RoundedSample = { round: number };

function indexByRound<T extends RoundedSample>(samples: T[]) {
	const samplesByRound = new Map<number, T>();
	for (const sample of samples) {
		if (sample.round <= 0) continue;
		samplesByRound.set(sample.round, sample);
	}
	return samplesByRound;
}

export function pairedDeltaSummary<T extends RoundedSample>(baseSamples: T[], headSamples: T[], getValue: (sample: T) => number | null | undefined) {
	const baseSamplesByRound = indexByRound(baseSamples);
	const headSamplesByRound = indexByRound(headSamples);
	const values: number[] = [];

	for (const [round, baseSample] of baseSamplesByRound) {
		const headSample = headSamplesByRound.get(round);
		if (headSample == null) continue;

		const baseValue = getValue(baseSample);
		const headValue = getValue(headSample);
		if (baseValue == null || headValue == null) continue;

		values.push(headValue - baseValue);
	}

	if (values.length === 0) throw new Error('No paired samples to compare: base and head have no rounds in common');

	return {
		median: median(values),
		mad: values.length < 2 ? 0 : mad(values),
		min: Math.min(...values),
		max: Math.max(...values),
		samples: values.length,
	};
}
