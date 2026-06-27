import { describe, expect, it } from "vitest";
import {
  chooseBestCandidate,
  formatTimestamp,
  hasBlockedTerms,
  isBradLikelyCandidate,
  isNonBradContext,
  sourceLink,
} from "./brad-voicepack.mjs";

describe("Brad voice-pack helpers", () => {
  it("formats transcript timestamps as HH:MM:SS", () => {
    expect(formatTimestamp(3852)).toBe("01:04:12");
    expect(formatTimestamp(-10)).toBe("00:00:00");
  });

  it("builds source links that match shitbradsays player routes", () => {
    expect(sourceLink({ contentType: "youtube", remoteId: "abc123", seconds: 95 })).toBe("https://www.youtube.com/watch?v=abc123&t=95s");
    expect(sourceLink({ contentType: "prankcast", remoteId: "42", seconds: 95 })).toBe("https://prankcast.com/phonelosers/posts/42#quote_at=00:01:35");
    expect(sourceLink({ contentType: "notla", remoteId: "1906", seconds: 95 })).toBe("https://www.notla.com/?p=1906#quote_at=00:01:35");
  });

  it("prefers direct audio candidates unless YouTube is explicitly preferred and downloadable", () => {
    const slot = { id: 18, description: "Charging", searches: ["charging"] };
    const direct = { contentType: "notla", remoteId: "1", mediaUrl: "https://example.com/a.mp3", seconds: 20, title: "Brad's Cactus Shack", preview: "charging this thing right now" };
    const youtube = { contentType: "youtube", remoteId: "v", mediaUrl: null, seconds: 10, title: "The Snow Plow Show", preview: "charging this thing right now" };

    expect(chooseBestCandidate([youtube, direct], slot)?.contentType).toBe("notla");
    expect(chooseBestCandidate([youtube, direct], slot, { preferYoutube: true, canDownloadYoutube: true })?.contentType).toBe("youtube");
    expect(chooseBestCandidate([youtube], slot, { preferYoutube: true })?.contentType).toBeUndefined();
  });

  it("filters blocked transcript terms by default", () => {
    const slot = { id: 44, description: "Error", searches: ["error"] };
    const blocked = { contentType: "notla", remoteId: "1", mediaUrl: "https://example.com/a.mp3", seconds: 1, title: "Brad's Cactus Shack", preview: "error with a faggot phrase" };
    const clean = { contentType: "notla", remoteId: "2", mediaUrl: "https://example.com/b.mp3", seconds: 2, title: "Brad's Cactus Shack", preview: "error with this account" };

    expect(hasBlockedTerms(blocked.preview)).toBe(true);
    expect(chooseBestCandidate([blocked, clean], slot)?.remoteId).toBe("2");
  });

  it("rejects generic caller and IVR matches unless loose mode is enabled", () => {
    const slot = { id: 7, description: "Start cleaning", searches: ["cleaning"] };
    const ivr = { contentType: "prankcast", remoteId: "1", mediaUrl: "https://example.com/a.mp3", seconds: 1, title: "The Callective hosted by RBCP", preview: "press one if you need emergency roadside cleaning" };
    const brad = { contentType: "youtube", remoteId: "2", mediaUrl: null, seconds: 2, title: "The Snow Plow Show Episode 901", preview: "this is the snow plow show I'm your host Brad" };

    expect(isNonBradContext(ivr)).toBe(true);
    expect(isBradLikelyCandidate(brad)).toBe(true);
    expect(chooseBestCandidate([ivr], slot)).toBeNull();
    expect(chooseBestCandidate([ivr], slot, { bradLikely: false, includePrankcast: true })?.remoteId).toBe("1");
  });
});