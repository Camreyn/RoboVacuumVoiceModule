import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const SHIT_BRAD_SEARCH_URL = "https://shitbradsays.com/";
const REFERENCE_REPO_URL = "https://github.com/Makers-Im-Zigerschlitz/voicepacks_dreame";
const DEFAULT_OUT_DIR = ".generated/brad-x40";
const DEFAULT_QUERY_LIMIT = 25;
const DEFAULT_CLIP_SECONDS = 3.8;
const DEFAULT_PREROLL_SECONDS = 0.55;
const DEFAULT_POSTROLL_SECONDS = 0.8;
const DEFAULT_MAX_CLIP_SECONDS = 8.5;
const DEFAULT_SILENCE_DURATION = 0.28;
const DEFAULT_SILENCE_THRESHOLD = -38;
const DIRECT_AUDIO_TYPES = new Set(["prankcast", "notla"]);
const BRAD_SOURCE_TITLE_PATTERNS = [
  /\bbrad\b/i,
  /snow plow show/i,
  /phone losers/i,
  /cactus shack/i,
  /\bpla\b/i,
];
const BRAD_PHRASE_PATTERNS = [
  /\bthis is brad\b/i,
  /\bbrad carter\b/i,
  /\bi'?m your host brad\b/i,
  /\bthis is the snow plow show\b/i,
  /\bphone losers\b/i,
  /\broycipians\b/i,
];
const NON_BRAD_CONTEXT_PATTERNS = [
  /\bpress one\b/i,
  /\bfor calling\b/i,
  /\bthis call may be recorded\b/i,
  /\bquality assurance\b/i,
  /\bif you are calling\b/i,
  /\bsky socks\b/i,
  /\bvoicemail\b/i,
  /\bplease try again later\b/i,
  /\bnot available\b/i,
  /\bhosted by rbcp\b/i,
  /\blive ding calls\b/i,
  /\bcarol's prank call kitchen\b/i,
  /\bthe callective\b/i,
];
const GLOBAL_BRAD_SEARCHES = [
  "this is brad",
  "this is the snow plow show",
  "I'm your host Brad",
  "brad carter",
  "phone losers",
  "roycipians",
];
const BLOCKED_TERMS = [
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "kill yourself",
  "rape",
  "slut",
  "whore",
];

const CORE_X40_SLOTS = [
  { id: 0, description: "Startup sound", curatedSearches: ["you forgot to say hello"], searches: ["hello", "wake up"] },
  { id: 7, description: "Start cleaning", curatedSearches: ["you need to clean up that yard", "finish up that mopping"], searches: ["start cleaning", "cleaning"] },
  { id: 8, description: "Start spot cleaning", curatedSearches: ["hole in your front yard", "come to my front"], searches: ["spot cleaning", "spot"] },
  { id: 11, description: "Paused", curatedSearches: ["one last chance to gain control"], searches: ["hang on", "wait a minute", "paused"], clipSeconds: 3.0 },
  { id: 12, description: "Cleaning task completed", curatedSearches: ["have a whatever day"], searches: ["done", "finished", "completed"] },
  { id: 13, description: "Returning to the dock to charge", curatedSearches: ["go back then to where you came from", "go back"], searches: ["return to the dock", "charging", "go back"] },
  { id: 14, description: "Low battery, returning to dock", curatedSearches: ["take the charge off", "change the battery right away"], searches: ["low battery", "charging"] },
  { id: 18, description: "Charging", curatedSearches: ["there's no charge for it", "take the charge off"], searches: ["charging"], clipSeconds: 3.0 },
  { id: 20, description: "Low battery", curatedSearches: ["always change the battery", "battery powered"], searches: ["battery", "low battery"], clipSeconds: 3.2 },
  { id: 22, description: "Move robot to area to clean", curatedSearches: ["clean up that yard", "front yard"], searches: ["clean this", "go over there", "cleaning"] },
  { id: 23, description: "Water tank installed", curatedSearches: ["water is going all over the floor", "black goopy stuff"], searches: ["water tank", "water"] },
  { id: 34, description: "Dustbin not installed", curatedSearches: ["trash cans", "pile of trash"], searches: ["trash", "garbage", "dust"] },
  { id: 35, description: "Main brush error", curatedSearches: ["who eats toothbrushes", "toothbrushes"], searches: ["brush", "clean brush"] },
  { id: 40, description: "Robot stuck", curatedSearches: ["pile of trash", "beeping and making these worrying sounds"], searches: ["stuck", "I'm stuck"] },
  { id: 44, description: "Generic error", curatedSearches: ["one last chance to gain control", "wrong with your sound"], searches: ["error", "problem"] },
  { id: 45, description: "I am here", curatedSearches: ["here I am I'm back", "here I am"], searches: ["I am here", "over here"], clipSeconds: 2.8 },
  { id: 47, description: "Start charging", curatedSearches: ["there's no charge for it", "take the charge off"], searches: ["start charging", "charging"] },
  { id: 50, description: "Charging error", curatedSearches: ["you will be charged two hundred dollars", "take the charge off"], searches: ["charging error", "clean contacts", "charging"] },
  { id: 56, description: "Start selected room cleaning", curatedSearches: ["what floor are you on", "which apartment"], searches: ["room cleaning", "cleaning room"] },
  { id: 57, description: "Start zoned cleaning", curatedSearches: ["front yard", "which apartment"], searches: ["zone", "area"] },
  { id: 59, description: "Mopping completed", curatedSearches: ["that area that I was mopping it got really clean"], searches: ["mopping completed", "done mopping", "mop"] },
  { id: 61, description: "Start mopping", curatedSearches: ["finish up that mopping", "pretty mouth"], searches: ["mopping", "mop"] },
  { id: 63, description: "Water tank removed", curatedSearches: ["stop flushing the toilet", "water is going all over the floor"], searches: ["water tank", "remove water"] },
  { id: 66, description: "Filter worn out", curatedSearches: ["filtering service", "mailboxes in the neighborhood"], searches: ["filter", "replace filter"] },
  { id: 69, description: "Cleanup path blocked", curatedSearches: ["blocked by trees", "blocked my number"], searches: ["blocked", "path blocked"] },
  { id: 70, description: "Remove and clean mop pad", curatedSearches: ["finish up that mopping", "mop bucket"], searches: ["mop pad", "remove mop", "clean mop"] },
  { id: 82, description: "Start mapping", curatedSearches: ["mapping up the whole store", "google maps"], searches: ["mapping", "map"] },
  { id: 84, description: "Mapping completed", curatedSearches: ["google maps is not letting me see them", "google maps"], searches: ["map complete", "completed map", "map"] },
  { id: 88, description: "Enter remote control mode", curatedSearches: ["we have cameras", "camera in the rooms"], searches: ["remote control"] },
  { id: 91, description: "Clean water tank not installed", curatedSearches: ["not enough water", "water keeps going on the floor"], searches: ["clean water tank", "water tank"] },
  { id: 93, description: "Not enough clean water", curatedSearches: ["not enough water", "black goopy stuff"], searches: ["not enough water", "water"] },
  { id: 94, description: "Dirty water tank full", curatedSearches: ["black goopy stuff", "water is going all over the floor"], searches: ["dirty water", "tank full"] },
  { id: 98, description: "Dust collection bag full", curatedSearches: ["trash cans", "pile of trash"], searches: ["bag full", "empty bag"] },
  { id: 106, description: "Start cleaning the mop", curatedSearches: ["finish up that mopping", "that area that I was mopping it got really clean"], searches: ["washing", "mop"] },
  { id: 110, description: "Start auto empty", curatedSearches: ["empty bottles of water", "toilet valve"], searches: ["auto empty", "emptying"] },
  { id: 116, description: "Child lock on", curatedSearches: ["locked up for the night", "you don't even know how a door works"], searches: ["locked", "buttons locked"] },
  { id: 143, description: "Cleaning completed", curatedSearches: ["have a whatever day", "stay out of my life"], searches: ["cleaning completed", "done cleaning", "finished"] },
  { id: 148, description: "Return to base for self-cleaning", curatedSearches: ["finish up that mopping", "have a whatever day"], searches: ["self cleaning", "return to base"] },
  { id: 154, description: "Operated too frequently", curatedSearches: ["you're so good at conversation", "please try again later"], searches: ["too often", "try again later"] },
  { id: 155, description: "Return to charging and mop dock", curatedSearches: ["go back to listening to dingtember", "take the charge off"], searches: ["charging dock", "return to dock"] },
  { id: 177, description: "Leaving base station", curatedSearches: ["come to my front", "front yard"], searches: ["leaving", "base station"] },
  { id: 188, description: "Automatic docking engaged", curatedSearches: ["docking section", "space station"], searches: ["docking", "automatic docking"] },
  { id: 200, description: "Shutdown sound", curatedSearches: ["I love you bye", "have a whatever day", "stay out of my life"], searches: ["goodbye", "shutting down"] },
  { id: 274, description: "Ding sound", curatedSearches: ["happy dingtember", "dinged your car"], searches: ["ding"], clipSeconds: 1.8 },
];

export function formatTimestamp(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return new Date(safeSeconds * 1000).toISOString().slice(11, 19);
}

export function sourceLink(candidate) {
  const seconds = Number(candidate.seconds) || 0;
  if (candidate.contentType === "youtube") {
    return `https://www.youtube.com/watch?v=${candidate.remoteId}${seconds ? `&t=${seconds}s` : ""}`;
  }
  if (candidate.contentType === "prankcast") {
    return `https://prankcast.com/phonelosers/posts/${candidate.remoteId}${seconds ? `#quote_at=${formatTimestamp(seconds)}` : ""}`;
  }
  if (candidate.contentType === "notla") {
    return `https://www.notla.com/?p=${candidate.remoteId}${seconds ? `#quote_at=${formatTimestamp(seconds)}` : ""}`;
  }
  if (candidate.contentType === "patreon") {
    return `https://www.patreon.com/posts/${candidate.remoteId}${seconds ? `#quote_at=${formatTimestamp(seconds)}` : ""}`;
  }
  return SHIT_BRAD_SEARCH_URL;
}

export function hasBlockedTerms(text, blockedTerms = BLOCKED_TERMS) {
  const normalized = String(text || "").toLowerCase();
  return blockedTerms.some((term) => normalized.includes(term));
}

export function isBradLikelyCandidate(candidate) {
  const preview = `${candidate.prefix || ""} ${candidate.preview || ""}`.trim();
  const text = `${candidate.title || ""} ${preview}`;
  return BRAD_SOURCE_TITLE_PATTERNS.some((pattern) => pattern.test(candidate.title || "")) || BRAD_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isNonBradContext(candidate) {
  const preview = `${candidate.prefix || ""} ${candidate.preview || ""}`.trim();
  const text = `${candidate.title || ""} ${preview}`;
  return NON_BRAD_CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}

export function scoreCandidate(candidate, slot, options = {}) {
  const preview = `${candidate.prefix || ""} ${candidate.preview || ""}`.trim();
  const text = `${candidate.title || ""} ${preview}`.toLowerCase();
  const words = preview.split(/\s+/).filter(Boolean).length;
  let score = 0;

  if (DIRECT_AUDIO_TYPES.has(candidate.contentType)) score += options.preferYoutube ? 4 : 32;
  if (candidate.contentType === "youtube") score += options.preferYoutube ? 28 : 8;
  if (candidate.contentType === "prankcast" && !options.includePrankcast) score -= 80;
  if (candidate.mediaUrl) score += 12;
  if (isBradLikelyCandidate(candidate)) score += 75;
  if (isNonBradContext(candidate)) score -= 90;
  if (options.usedSourceKeys?.has(sourceKey(candidate))) score -= 1000;
  if (options.usedPreviewKeys?.has(previewKey(candidate))) score -= 1000;
  if (words >= 5 && words <= 20) score += 20;
  if (words > 20) score -= Math.min(20, words - 20);
  if (words < 5) score -= 12;

  const curatedSearches = slot.curatedSearches || [];
  if (curatedSearches.includes(candidate.search)) score += 95;

  for (const search of [...curatedSearches, ...(slot.searches || [])]) {
    const terms = String(search).toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    for (const term of terms) {
      if (text.includes(term)) score += 5;
    }
  }

  if (/^\s*(um|uh|yeah|okay)\b/i.test(preview)) score -= 5;
  if (!options.allowExplicit && hasBlockedTerms(text)) score -= 1000;
  if (options.bradLikely !== false && !isBradLikelyCandidate(candidate)) score -= 1000;
  return score;
}

export function chooseBestCandidate(candidates, slot, options = {}) {
  const eligible = candidates
    .filter((candidate) => !options.directOnly || DIRECT_AUDIO_TYPES.has(candidate.contentType))
    .filter((candidate) => candidate.contentType !== "youtube" || options.canDownloadYoutube || options.dryRun)
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, slot, options) }))
    .filter((candidate) => candidate.score > -500)
    .sort((left, right) => right.score - left.score || left.seconds - right.seconds);

  return eligible[0] || null;
}

export async function searchQuotes(search, options = {}) {
  const url = new URL(SHIT_BRAD_SEARCH_URL);
  url.searchParams.set("search", search);
  if (options.patreon) url.searchParams.set("patreon", "true");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "dreame-brad-voicepack-builder/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`shitbradsays search failed for "${search}" with HTTP ${response.status}`);
  }

  return response.json();
}

export async function findSlotQuote(slot, options = {}) {
  const allCandidates = [];
  const seen = new Set();

  const slotSearches = [...(slot.curatedSearches || []), ...(slot.searches || [])];
  const searches = [...new Set(options.bradLikely === false ? slotSearches : [...slotSearches, ...GLOBAL_BRAD_SEARCHES])];

  for (const search of searches) {
    const results = await searchQuotes(search, options);
    for (const result of results.slice(0, options.queryLimit ?? DEFAULT_QUERY_LIMIT)) {
      for (const timestamp of result.timestamps || []) {
        const key = `${result.content_type}:${result.remote_id}:${timestamp.seconds}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCandidates.push({
          slotId: slot.id,
          slotDescription: slot.description,
          search,
          contentType: result.content_type,
          remoteId: result.remote_id,
          title: result.title,
          uploadedAt: result.uploaded_at,
          mediaUrl: result.media_url,
          seconds: timestamp.seconds,
          timestamp: formatTimestamp(timestamp.seconds),
          prefix: timestamp.prefix || "",
          preview: timestamp.preview || "",
        });
      }
    }
  }

  const selected = chooseBestCandidate(allCandidates, slot, options);
  return {
    slot,
    selected: selected ? { ...selected, link: sourceLink(selected) } : null,
    candidates: allCandidates
      .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, slot, options), link: sourceLink(candidate) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5),
  };
}

async function buildPack(options) {
  const outDir = resolve(options.outDir || DEFAULT_OUT_DIR);
  const clipsDir = join(outDir, "clips");
  await rm(clipsDir, { recursive: true, force: true });
  await mkdir(clipsDir, { recursive: true });

  const ytDlpCommand = await resolveYtDlpCommand(options);
  const tools = {
    ffmpeg: await commandExists("ffmpeg"),
    ytDlp: Boolean(ytDlpCommand),
    ytDlpCommand,
    tar: await commandExists("tar"),
  };

  const usableOptions = {
    ...options,
    canDownloadYoutube: Boolean(ytDlpCommand),
    ytDlpCommand,
  };

  const slots = selectedSlots(options);
  const manifest = {
    generatedAt: new Date().toISOString(),
    quoteSearch: SHIT_BRAD_SEARCH_URL,
    referenceRepo: REFERENCE_REPO_URL,
    outputFormat: "numbered ogg clips at archive root",
    tools,
    options: {
      clipSeconds: options.clipSeconds,
      prerollSeconds: options.prerollSeconds ?? DEFAULT_PREROLL_SECONDS,
      postrollSeconds: options.postrollSeconds ?? DEFAULT_POSTROLL_SECONDS,
      maxClipSeconds: options.maxClipSeconds ?? DEFAULT_MAX_CLIP_SECONDS,
      silenceTrim: options.silenceTrim !== false,
      directOnly: usableOptions.directOnly,
      allowExplicit: Boolean(options.allowExplicit),
      patreon: Boolean(options.patreon),
      bradLikely: usableOptions.bradLikely !== false,
      includePrankcast: Boolean(options.includePrankcast),
      ytRemoteComponents: Boolean(options.ytRemoteComponents),
    },
    clips: [],
  };
  const usedSourceKeys = new Set();
  const usedPreviewKeys = new Set();

  for (const slot of slots) {
    process.stdout.write(`Searching ${slot.id}.ogg (${slot.description})... `);
    const result = await findSlotQuote(slot, { ...usableOptions, usedSourceKeys, usedPreviewKeys });
    if (!result.selected) {
      console.log("no match");
      manifest.clips.push({ slot, status: "skipped", reason: "No eligible quote found", candidates: result.candidates });
      continue;
    }

    const clip = {
      slot,
      status: options.dryRun ? "planned" : "pending",
      source: result.selected,
      candidates: result.candidates,
      output: `${slot.id}.ogg`,
    };
    manifest.clips.push(clip);
    usedSourceKeys.add(sourceKey(result.selected));
    usedPreviewKeys.add(previewKey(result.selected));
    console.log(`${result.selected.contentType} ${result.selected.timestamp}`);

    if (!options.dryRun) {
      if (!tools.ffmpeg) throw new Error("ffmpeg is required to cut and normalize clips.");
      const outputPath = join(clipsDir, `${slot.id}.ogg`);
      try {
        clip.clipWindow = await createClip(result.selected, outputPath, slot, options, tools);
        clip.status = "created";
        clip.outputPath = outputPath;
      } catch (error) {
        clip.status = "skipped";
        clip.reason = error instanceof Error ? error.message : "Clip generation failed";
        await rm(outputPath, { force: true });
        console.warn(`skipped ${slot.id}.ogg: ${clip.reason}`);
      }
    }
  }

  await writeManifest(outDir, manifest);

  if (!options.dryRun && options.package) {
    if (!tools.tar) throw new Error("tar is required for --package.");
    const archivePath = join(outDir, "brad-x40.tar.gz");
    await run("tar", ["-czf", archivePath, "-C", clipsDir, "."]);
    manifest.package = {
      path: archivePath,
      md5: await md5File(archivePath),
    };
    await writeManifest(outDir, manifest);
  }

  return manifest;
}

async function createClip(candidate, outputPath, slot, options, tools) {
  const timing = estimateClipTiming(candidate, slot, options);
  const source = await mediaInput(candidate, tools, {
    start: timing.start,
    duration: timing.scanDuration,
    cacheDir: join(dirname(outputPath), "..", "source-cache"),
  });

  let duration = timing.scanDuration;
  let trimStrategy = "estimated-transcript-window";
  if (options.silenceTrim !== false) {
    try {
      const silenceStarts = await detectSilenceStarts(source.url, timing.start, timing.scanDuration, options);
      const naturalDuration = chooseNaturalClipDuration(silenceStarts, timing.minDuration, timing.scanDuration, options);
      if (naturalDuration < timing.scanDuration) {
        duration = naturalDuration;
        trimStrategy = "silence-aware";
      }
    } catch (error) {
      console.warn("silence scan failed for " + outputPath + ": " + (error instanceof Error ? error.message : error));
    }
  }

  const filters = audioFilters(duration);

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    timing.start.toFixed(2),
    "-err_detect",
    "ignore_err",
    "-i",
    source.url,
    "-t",
    duration.toFixed(2),
    "-vn",
    "-af",
    filters,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "libvorbis",
    outputPath,
  ]);

  const outputStat = await stat(outputPath);
  if (outputStat.size < 1024) throw new Error("Generated clip " + outputPath + " is too small to be valid.");

  return {
    strategy: trimStrategy,
    start: Number(timing.start.toFixed(2)),
    duration: Number(duration.toFixed(2)),
    scanDuration: Number(timing.scanDuration.toFixed(2)),
    minDuration: Number(timing.minDuration.toFixed(2)),
    wordCount: timing.wordCount,
  };
}

export function estimateClipTiming(candidate, slot = {}, options = {}) {
  const baseClipSeconds = Number(slot.clipSeconds || options.clipSeconds || DEFAULT_CLIP_SECONDS);
  const preroll = Number(options.prerollSeconds ?? DEFAULT_PREROLL_SECONDS);
  const postroll = Number(options.postrollSeconds ?? DEFAULT_POSTROLL_SECONDS);
  const maxClipSeconds = Number(options.maxClipSeconds ?? DEFAULT_MAX_CLIP_SECONDS);
  const wordCount = transcriptWordCount(candidate);
  const estimatedSpeechSeconds = slot.clipSeconds && baseClipSeconds <= 2.5 ? baseClipSeconds : Math.max(baseClipSeconds, wordCount * 0.31 + 0.75);
  const scanDuration = clamp(preroll + estimatedSpeechSeconds + postroll, Math.max(0.6, baseClipSeconds + preroll), maxClipSeconds);
  const minDuration = clamp(preroll + Math.max(baseClipSeconds, estimatedSpeechSeconds * 0.72), 0.6, scanDuration);

  return {
    start: Math.max(0, Number(candidate.seconds) - preroll),
    scanDuration,
    minDuration,
    wordCount,
  };
}

export function transcriptWordCount(candidate) {
  return String((candidate.prefix || "") + " " + (candidate.preview || ""))
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 24)
    .length;
}

export function chooseNaturalClipDuration(silenceStarts, minDuration, scanDuration, options = {}) {
  const postroll = Number(options.postrollSeconds ?? DEFAULT_POSTROLL_SECONDS);
  const tailPadding = Math.min(0.18, Math.max(0.05, postroll / 5));
  const naturalEnd = silenceStarts.find((seconds) => seconds >= minDuration && seconds <= scanDuration - 0.08);
  return naturalEnd === undefined ? scanDuration : Math.min(scanDuration, naturalEnd + tailPadding);
}

async function detectSilenceStarts(inputUrl, start, duration, options = {}) {
  const threshold = Number(options.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD);
  const silenceDuration = Number(options.silenceDuration ?? DEFAULT_SILENCE_DURATION);
  const output = await runCapture("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss",
    start.toFixed(2),
    "-err_detect",
    "ignore_err",
    "-i",
    inputUrl,
    "-t",
    duration.toFixed(2),
    "-af",
    "silencedetect=n=" + threshold + "dB:d=" + silenceDuration,
    "-f",
    "null",
    "-",
  ]);

  return [...output.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
}

function audioFilters(duration) {
  const fadeOutStart = Math.max(0, duration - 0.18).toFixed(2);
  return [
    "highpass=f=90",
    "lowpass=f=7600",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "afade=t=in:st=0:d=0.04",
    "afade=t=out:st=" + fadeOutStart + ":d=0.18",
  ].join(",");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function mediaInput(candidate, tools, options = {}) {
  if (candidate.mediaUrl) return { url: candidate.mediaUrl };
  if (candidate.contentType !== "youtube") throw new Error(`No downloadable media URL for ${candidate.contentType}.`);
  if (!tools.ytDlpCommand) throw new Error("yt-dlp is required for YouTube clips.");

  const cacheDir = options.cacheDir || resolve(DEFAULT_OUT_DIR, "source-cache");
  await mkdir(cacheDir, { recursive: true });
  const outputStem = String(candidate.remoteId).replace(/[^a-zA-Z0-9._-]/g, "_");
  let files = await readdir(cacheDir);
  let downloaded = files.find((file) => file.startsWith(`${outputStem}.`) && !file.endsWith(".part"));

  if (!downloaded) {
    await run(tools.ytDlpCommand.command, [
      ...tools.ytDlpCommand.argsPrefix,
      "--no-playlist",
      "-f",
      "ba",
      "-o",
      join(cacheDir, `${outputStem}.%(ext)s`),
      `https://www.youtube.com/watch?v=${candidate.remoteId}`,
    ]);

    files = await readdir(cacheDir);
    downloaded = files.find((file) => file.startsWith(`${outputStem}.`) && !file.endsWith(".part"));
  }

  if (!downloaded) throw new Error(`yt-dlp did not create an audio file for ${sourceLink(candidate)}`);
  return { url: join(cacheDir, downloaded) };
}

function sourceKey(candidate) {
  return `${candidate.contentType}:${candidate.remoteId}:${candidate.seconds}`;
}

function previewKey(candidate) {
  return `${candidate.prefix || ""} ${candidate.preview || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .join(" ");
}

function selectedSlots(options) {
  let slots = CORE_X40_SLOTS;
  if (options.soundIds?.length) {
    const selected = new Set(options.soundIds.map(Number));
    slots = slots.filter((slot) => selected.has(slot.id));
  }
  if (options.maxSlots) slots = slots.slice(0, Number(options.maxSlots));
  return slots;
}

async function writeManifest(outDir, manifest) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const csv = [
    "sound_id,description,status,content_type,timestamp,link,title,preview",
    ...manifest.clips.map((clip) =>
      [
        clip.slot.id,
        csvValue(clip.slot.description),
        clip.status,
        clip.source?.contentType || "",
        clip.source?.timestamp || "",
        csvValue(clip.source?.link || ""),
        csvValue(clip.source?.title || ""),
        csvValue(`${clip.source?.prefix || ""} ${clip.source?.preview || ""}`.trim()),
      ].join(","),
    ),
  ].join("\n");
  await writeFile(join(outDir, "source-manifest.csv"), `${csv}\n`);
}

function csvValue(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function commandExists(command) {
  const versionArgs = command === "ffmpeg" ? ["-version"] : ["--version"];
  try {
    await run(command, versionArgs, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function resolveYtDlpCommand(options = {}) {
  const youtubeArgs = options.ytRemoteComponents
    ? ["--js-runtimes", "node", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=default,web,android_vr"]
    : [];
  const candidates = [
    { command: "yt-dlp", argsPrefix: youtubeArgs },
    { command: "python", argsPrefix: ["-m", "yt_dlp", ...youtubeArgs] },
  ];

  for (const candidate of candidates) {
    try {
      await run(candidate.command, [...candidate.argsPrefix, "--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next known invocation style.
    }
  }

  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || "inherit", env: childEnvWithoutProxy() });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnvWithoutProxy() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout + "\n" + stderr);
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

function childEnvWithoutProxy() {
  const env = { ...process.env, NO_PROXY: "*", no_proxy: "*" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete env[key];
  }
  return env;
}
async function md5File(path) {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    clipSeconds: DEFAULT_CLIP_SECONDS,
    queryLimit: DEFAULT_QUERY_LIMIT,
    package: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--out") options.outDir = next();
    else if (arg === "--max-slots") options.maxSlots = Number(next());
    else if (arg === "--sound-ids") options.soundIds = next().split(",").map((value) => Number(value.trim()));
    else if (arg === "--query-limit") options.queryLimit = Number(next());
    else if (arg === "--clip-seconds") options.clipSeconds = Number(next());
    else if (arg === "--preroll-seconds") options.prerollSeconds = Number(next());
    else if (arg === "--postroll-seconds") options.postrollSeconds = Number(next());
    else if (arg === "--max-clip-seconds") options.maxClipSeconds = Number(next());
    else if (arg === "--silence-threshold") options.silenceThreshold = Number(next());
    else if (arg === "--silence-duration") options.silenceDuration = Number(next());
    else if (arg === "--no-silence-trim") options.silenceTrim = false;
    else if (arg === "--direct-only") options.directOnly = true;
    else if (arg === "--prefer-youtube") options.preferYoutube = true;
    else if (arg === "--include-prankcast") options.includePrankcast = true;
    else if (arg === "--yt-remote-components") options.ytRemoteComponents = true;
    else if (arg === "--loose") options.bradLikely = false;
    else if (arg === "--allow-explicit") options.allowExplicit = true;
    else if (arg === "--patreon") options.patreon = true;
    else if (arg === "--no-package") options.package = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Build a Dreame X40 Brad quote voice pack.

Usage:
  npm run build:brad-pack -- -- [options]

Options:
  --dry-run                 Search and write manifests without downloading audio.
  --out <dir>               Output directory. Default: ${DEFAULT_OUT_DIR}
  --sound-ids <ids>         Comma-separated sound IDs, for example 7,13,18.
  --max-slots <number>      Process only the first N configured X40 slots.
  --query-limit <number>    Results to inspect per search term. Default: ${DEFAULT_QUERY_LIMIT}
  --clip-seconds <number>   Minimum speech window. Default: ${DEFAULT_CLIP_SECONDS}
  --preroll-seconds <n>     Seconds to include before transcript hit. Default: ${DEFAULT_PREROLL_SECONDS}
  --postroll-seconds <n>    Extra tail used while finding a natural stop. Default: ${DEFAULT_POSTROLL_SECONDS}
  --max-clip-seconds <n>    Maximum generated clip length. Default: ${DEFAULT_MAX_CLIP_SECONDS}
  --no-silence-trim         Disable natural-stop detection and use transcript estimate only.
  --direct-only             Use only Prankcast/notla direct-audio sources.
  --prefer-youtube          Prefer YouTube matches. Requires yt-dlp for download.
  --yt-remote-components    Allow yt-dlp to use its remote JS challenge solver.
  --allow-explicit          Disable the default transcript blocklist.
  --patreon                 Include Patreon transcript hits in searches.
  --no-package              Leave numbered OGG files unpacked.
`);
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  buildPack(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
