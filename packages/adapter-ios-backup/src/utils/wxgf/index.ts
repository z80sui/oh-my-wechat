import { FFmpeg } from "@ffmpeg/ffmpeg";
import { AsyncQueuer } from "@tanstack/pacer";
import { loadFFmpeg } from "../ffmpeg";
import { convertHevcToImage, wxgfToHevc } from "./utils";

let ffmpeg: FFmpeg | undefined;

type WxgfQueueItemProps = {
	wxgf: Uint8Array;
	onSuccess?: (result: string) => void;
	onError?: (error: unknown) => void;
	onSettled?: () => void;
};

async function processQueueItem(item: WxgfQueueItemProps): Promise<string> {
	if (!ffmpeg) throw new Error("FFmpeg is not loaded");

	const hevcData = new Uint8Array(wxgfToHevc(item.wxgf));
	return convertHevcToImage(hevcData, ffmpeg);
}

export const wxgfQueue = new AsyncQueuer<WxgfQueueItemProps>(processQueueItem, {
	onSuccess(result, item) {
		item.onSuccess?.(result);
	},
	onError(error, item) {
		item.onError?.(error);
	},
	onSettled(item) {
		item.onSettled?.();
	},
	concurrency: 1,
	started: false,
});

loadFFmpeg()
	.then((ffmpegInstance) => {
		ffmpeg = ffmpegInstance;
		wxgfQueue.start();
	})
	.catch((error) => {
		console.error(error);
	});

export async function convertWxgfToImage(wxgf: Uint8Array): Promise<string> {
	return await new Promise((resolve, reject) => {
		wxgfQueue.addItem({
			wxgf,
			onSuccess(result) {
				resolve(result);
			},
			onError(error) {
				reject(error);
			},
		});
	});
}
