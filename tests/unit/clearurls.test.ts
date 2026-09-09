import { describe, test, expect } from "bun:test";
import { applyClearUrls, loadClearUrlsForTest } from "../../src/server/search/clearurls";
import { cleanUrl } from "../../src/server/search/url-normalize";

// A cut-down ruleset in the real ClearURLs shape, so these assert on rule SEMANTICS rather than on
// whatever the live ruleset happens to contain today.
const RULES = {
  globalRules: {
    urlPattern: ".*",
    rules: ["utm_[^=]*", "ref_?src"],
    exceptions: ["^https?:\\/\\/(?:[a-z0-9-]+\\.)*?example\\.org"],
  },
  amazon: {
    urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?amazon(?:\\.[a-z]{2,}){1,}",
    rules: ["pd_rd_[^=]*", "psc"],
    referralMarketing: ["tag"],
  },
  google: {
    urlPattern: "^https?:\\/\\/(?:[a-z0-9-]+\\.)*?google(?:\\.[a-z]{2,}){1,}",
    rules: ["ved", "ei"],
    redirections: ["^https?:\\/\\/(?:[a-z0-9-]+\\.)*?google(?:\\.[a-z]{2,}){1,}\\/url\\?.*?url=([^&]*)"],
  },
};

describe("clearurls", () => {
  test("strips site-specific parameters the static list does not know", () => {
    loadClearUrlsForTest(RULES);
    const out = applyClearUrls(
      "https://www.amazon.de/dp/B0TEST?pd_rd_w=abc&psc=1&keywords=kettle",
    );
    expect(out).not.toContain("pd_rd_w");
    expect(out).not.toContain("psc=");
    expect(out).toContain("keywords=kettle");
  });

  test("strips referral marketing parameters", () => {
    loadClearUrlsForTest(RULES);
    expect(applyClearUrls("https://www.amazon.de/dp/B0TEST?tag=someaffiliate")).not.toContain("tag=");
  });

  test("unwraps a redirector to its destination", () => {
    loadClearUrlsForTest(RULES);
    expect(
      applyClearUrls("https://www.google.com/url?sa=t&url=https%3A%2F%2Fnixos.org%2F"),
    ).toBe("https://nixos.org/");
  });

  test("honours provider exceptions", () => {
    loadClearUrlsForTest(RULES);
    const url = "https://example.org/page?utm_source=news";
    expect(applyClearUrls(url)).toContain("utm_source=news");
  });

  test("leaves a URL with no matching rule untouched", () => {
    loadClearUrlsForTest(RULES);
    const url = "https://nixos.org/manual?page=2";
    expect(applyClearUrls(url)).toBe(url);
  });

  test("returns the input unchanged when it is not a URL", () => {
    loadClearUrlsForTest(RULES);
    expect(applyClearUrls("not a url")).toBe("not a url");
  });

  test("cleanUrl still applies the static list, and now ClearURLs too", () => {
    loadClearUrlsForTest(RULES);
    const out = cleanUrl("https://www.amazon.de/dp/B0TEST?fbclid=xyz&pd_rd_w=abc&psc=1");
    expect(out).not.toContain("fbclid"); // static list
    expect(out).not.toContain("pd_rd_w"); // ClearURLs
  });

  test("no ruleset loaded means the URL is returned unchanged", () => {
    loadClearUrlsForTest({});
    const url = "https://www.amazon.de/dp/B0TEST?pd_rd_w=abc";
    expect(applyClearUrls(url)).toBe(url);
  });
});
