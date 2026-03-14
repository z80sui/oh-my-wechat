import type { FFmpeg } from "@ffmpeg/ffmpeg";

const WXGF_HEADER = new Uint8Array([0x77, 0x78, 0x67, 0x66]); // "wxgf"

/** Check if data starts with WXGF magic bytes */
export function isWxgf(data: Uint8Array): boolean {
	return (
		data.length >= 4 &&
		data[0] === WXGF_HEADER[0] &&
		data[1] === WXGF_HEADER[1] &&
		data[2] === WXGF_HEADER[2] &&
		data[3] === WXGF_HEADER[3]
	);
}
const NAL_PATTERNS = [
	new Uint8Array([0x00, 0x00, 0x00, 0x01]),
	new Uint8Array([0x00, 0x00, 0x01]),
];
const MIN_RATIO = 0.6;

export interface DataPartition {
	offset: number;
	size: number;
	ratio: number;
}

export interface FindDataPartitionResult {
	partitions: DataPartition[];
	maxIndex: number;
	maxRatio: number;
}

export function findPattern(data: Uint8Array, pattern: Uint8Array): number {
	outer: for (let i = 0; i <= data.length - pattern.length; i++) {
		for (let j = 0; j < pattern.length; j++) {
			if (data[i + j] !== pattern[j]) continue outer;
		}
		return i;
	}
	return -1;
}

export function findDataPartition(data: Uint8Array): FindDataPartitionResult {
	if (
		data.length < 15 ||
		!data.slice(0, 4).every((b, i) => b === WXGF_HEADER[i])
	) {
		throw new Error("invalid wxgf");
	}

	const headerLen = data[4];
	if (headerLen >= data.length) {
		throw new Error("invalid wxgf");
	}

	for (const pattern of NAL_PATTERNS) {
		const partitions: DataPartition[] = [];
		let maxRatio = 0;
		let maxIndex = 0;
		let offset = 0;

		while (headerLen + offset <= data.length) {
			const searchStart = headerLen + offset;
			const searchData = data.subarray(searchStart);
			const index = findPattern(searchData, pattern);

			if (index === -1) break;

			const absIndex = searchStart + index;
			if (absIndex < 4) {
				offset += index + 1;
				continue;
			}

			const length =
				(data[absIndex - 4]! << 24) |
				(data[absIndex - 3]! << 16) |
				(data[absIndex - 2]! << 8) |
				data[absIndex - 1]!;

			if (length <= 0 || absIndex + length > data.length) {
				offset += index + 1;
				continue;
			}

			const ratio = length / data.length;
			partitions.push({ offset: absIndex, size: length, ratio });
			if (ratio > maxRatio) {
				maxRatio = ratio;
				maxIndex = partitions.length - 1;
			}
			offset += index + length;
		}

		if (partitions.length > 0) {
			return { partitions, maxIndex, maxRatio };
		}
	}

	throw new Error("no partition found");
}

/**
 * Extract HEVC frame data from WXGF format.
 * @throws Error for anime format (multiple partitions with low max ratio)
 */
export function wxgfToHevc(data: Uint8Array): Uint8Array {
	const { partitions, maxIndex, maxRatio } = findDataPartition(data);

	if (partitions.length > 1 && maxRatio < MIN_RATIO) {
		throw new Error("anime format not supported");
	}

	const { offset, size } = partitions[maxIndex]!;
	return data.subarray(offset, offset + size);
}

const FFMPEG_INPUT_FILENAME = "wxgf_input.hevc";
const FFMPEG_OUTPUT_FILENAME = "wxgf_output.png";

/**
 * Convert HEVC data to PNG using FFmpeg.
 * HEVC from WXGF uses YUV420P(tv) = limited range (16-235).
 * PNG expects full range (0-255). Scale filter converts range to fix color shift.
 * 使用 PNG 而非 JPG，避免 mjpeg 编码器触发内存问题。
 */
export async function convertHevcToImage(
	hevcData: Uint8Array,
	ffmpeg: FFmpeg,
): Promise<string> {
	try {
		await ffmpeg.writeFile(FFMPEG_INPUT_FILENAME, hevcData);
		const exitCode = await ffmpeg.exec([
			"-y",
			"-i",
			FFMPEG_INPUT_FILENAME,
			"-vframes",
			"1",
			"-vf",
			"scale=in_range=tv:out_range=full",
			"-f",
			"image2",
			FFMPEG_OUTPUT_FILENAME,
		]);
		if (exitCode !== 0) {
			throw new Error(`FFmpeg exec failed with exit code ${exitCode}`);
		}
		const pngData = await ffmpeg.readFile(FFMPEG_OUTPUT_FILENAME);
		if (!(pngData instanceof Uint8Array)) {
			throw new Error("Expected binary data from ffmpeg readFile");
		}
		return URL.createObjectURL(
			new Blob([new Uint8Array(pngData)], { type: "image/png" }),
		);
	} finally {
		try {
			await ffmpeg.deleteFile(FFMPEG_INPUT_FILENAME);
			await ffmpeg.deleteFile(FFMPEG_OUTPUT_FILENAME);
		} catch {
			// ignore cleanup errors
		}
	}
}
