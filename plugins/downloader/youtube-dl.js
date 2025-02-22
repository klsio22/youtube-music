const { randomBytes } = require("crypto");
const { writeFileSync } = require("fs");
const { join } = require("path");

const Mutex = require("async-mutex").Mutex;
const ID3Writer = require("browser-id3-writer");
const { ipcRenderer } = require("electron");
const is = require("electron-is");
const filenamify = require("filenamify");

// Browser version of FFmpeg (in renderer process) instead of loading @ffmpeg/ffmpeg
// because --js-flags cannot be passed in the main process when the app is packaged
// See https://github.com/electron/electron/issues/22705
const FFmpeg = require("@ffmpeg/ffmpeg/dist/ffmpeg.min");
const ytdl = require("ytdl-core");

const { triggerAction, triggerActionSync } = require("../utils");
const { ACTIONS, CHANNEL } = require("./actions.js");
const { defaultMenuDownloadLabel, getFolder } = require("./utils");

const { createFFmpeg } = FFmpeg;
const ffmpeg = createFFmpeg({
	log: false,
	logger: () => {}, // console.log,
	progress: () => {}, // console.log,
});
const ffmpegMutex = new Mutex();

const downloadVideoToMP3 = (
	videoUrl,
	sendFeedback,
	sendError,
	reinit,
	options,
	metadata = undefined,
	subfolder = ""
) => {
	sendFeedback("Downloading…");

	let videoName = "YouTube Music - Unknown title";
	let videoReadableStream;
	try {
		videoReadableStream = ytdl(videoUrl, {
			filter: "audioonly",
			quality: "highestaudio",
			highWaterMark: 32 * 1024 * 1024, // 32 MB
			requestOptions: { maxRetries: 3 },
		});
	} catch (err) {
		sendError(err);
		return;
	}

	const chunks = [];
	videoReadableStream
		.on("data", (chunk) => {
			chunks.push(chunk);
		})
		.on("progress", (chunkLength, downloaded, total) => {
			const progress = Math.floor((downloaded / total) * 100);
			sendFeedback("Download: " + progress + "%");
		})
		.on("info", (info, format) => {
			videoName = info.videoDetails.title.replace("|", "").toString("ascii");
			if (is.dev()) {
				console.log(
					"Downloading video - name:",
					videoName,
					"- quality:",
					format.audioBitrate + "kbits/s"
				);
			}
		})
		.on("error", sendError)
		.on("end", async () => {
			const buffer = Buffer.concat(chunks);
			await toMP3(
				videoName,
				buffer,
				sendFeedback,
				sendError,
				reinit,
				options,
				metadata,
				subfolder
			);
		});
};

const toMP3 = async (
	videoName,
	buffer,
	sendFeedback,
	sendError,
	reinit,
	options,
	existingMetadata = undefined,
	subfolder = ""
) => {
	const safeVideoName = randomBytes(32).toString("hex");
	const extension = options.extension || "mp3";
	const releaseFFmpegMutex = await ffmpegMutex.acquire();

	try {
		if (!ffmpeg.isLoaded()) {
			sendFeedback("Loading…");
			await ffmpeg.load();
		}

		sendFeedback("Preparing file…");
		ffmpeg.FS("writeFile", safeVideoName, buffer);

		sendFeedback("Converting…");
		const metadata = existingMetadata || getMetadata();
		await ffmpeg.run(
			"-i",
			safeVideoName,
			...getFFmpegMetadataArgs(metadata),
			...(options.ffmpegArgs || []),
			safeVideoName + "." + extension
		);

		const folder = getFolder(options.downloadFolder);
		const name = metadata.title
			? `${metadata.artist ? `${metadata.artist} - ` : ""}${metadata.title}`
			: videoName;
		const filename = filenamify(name + "." + extension, {
			replacement: "_",
		});

		const filePath = join(folder, subfolder, filename);
		const fileBuffer = ffmpeg.FS("readFile", safeVideoName + "." + extension);

		// Add the metadata
		try {
			const writer = new ID3Writer(fileBuffer);
			if (metadata.image) {
				const coverBuffer = metadata.image.toPNG();

				// Create the metadata tags
				writer
					.setFrame("TIT2", metadata.title)
					.setFrame("TPE1", [metadata.artist])
					.setFrame("APIC", {
						type: 3,
						data: coverBuffer,
						description: "",
					});
				writer.addTag();
			}

			writeFileSync(filePath, Buffer.from(writer.arrayBuffer));
		} catch (error) {
			sendError(error);
		} finally {
			reinit();
		}
	} catch (e) {
		sendError(e);
	} finally {
		releaseFFmpegMutex();
	}
};

const getMetadata = () => {
	return JSON.parse(triggerActionSync(CHANNEL, ACTIONS.METADATA));
};

const getFFmpegMetadataArgs = (metadata) => {
	if (!metadata) {
		return;
	}

	return [
		...(metadata.title ? ["-metadata", `title=${metadata.title}`] : []),
		...(metadata.artist ? ["-metadata", `artist=${metadata.artist}`] : []),
	];
};

module.exports = {
	downloadVideoToMP3,
};

ipcRenderer.on(
	"downloader-download-playlist",
	(_, songMetadata, playlistFolder, options) => {
		const reinit = () =>
			ipcRenderer.send("downloader-feedback", defaultMenuDownloadLabel);

		downloadVideoToMP3(
			songMetadata.url,
			(feedback) => {
				ipcRenderer.send("downloader-feedback", feedback);
			},
			(error) => {
				triggerAction(CHANNEL, ACTIONS.ERROR, error);
				reinit();
			},
			reinit,
			options,
			songMetadata,
			playlistFolder
		);
	}
);
