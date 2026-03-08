import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(outputTrack.codec).toBe('aac');
	expect(outputTrack.sampleRate).toBe(inputTrack.sampleRate);
	expect(outputTrack.numberOfChannels).toBe(inputTrack.numberOfChannels);

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('Fragmented fMP4 accepts a GOP whose opening key packet has later PTS than following delta packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video-h265.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const firstKey = await sink.getKeyPacket(0);
	assert(firstKey);

	const secondKey = await sink.getNextKeyPacket(firstKey);
	assert(secondKey);

	const thirdKey = await sink.getNextKeyPacket(secondKey);

	const packets = [];
	let packet = secondKey;
	while (packet && (!thirdKey || packet.sequenceNumber !== thirdKey.sequenceNumber)) {
		packets.push(packet);
		const next = await sink.getNextPacket(packet);
		if (!next || next.sequenceNumber === packet.sequenceNumber) break;
		packet = next;
	}

	expect(packets.length).toBeGreaterThan(1);
	expect(packets[0]!.type).toBe('key');

	const openingPts = packets[0]!.timestamp;
	const hasEarlierDeltaPts = packets
		.slice(1)
		.some(p => p.type === 'delta' && p.timestamp < openingPts);
	expect(hasEarlierDeltaPts).toBe(true);

	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < packets.length; i++) {
		await videoSource.add(packets[i]!, i === 0 ? { decoderConfig } : undefined);
	}

	await expect(output.finalize()).resolves.toBeUndefined();
});
