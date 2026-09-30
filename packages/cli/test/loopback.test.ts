import { describe, expect, it } from "vitest";

import { isLoopbackHttp } from "../src/run/loopback.js";

describe("isLoopbackHttp (D-16)", () => {
  it.each([
    "http://localhost:1234/token",
    "http://127.0.0.1:9/token",
    "http://[::1]:5/token",
    "http://LOCALHOST:80/token",
  ])("allows the insecure flag for loopback http: %s", (url) => {
    expect(isLoopbackHttp(url)).toBe(true);
  });

  it("MANDATORY negative: a non-loopback http authorization server is still refused", () => {
    expect(isLoopbackHttp("http://as.example.test/token")).toBe(false);
    expect(isLoopbackHttp("http://10.0.0.5/token")).toBe(false);
    expect(isLoopbackHttp("http://0.0.0.0:8080/token")).toBe(false);
  });

  it("https never needs (and never gets) the flag", () => {
    expect(isLoopbackHttp("https://as.example.test/token")).toBe(false);
    expect(isLoopbackHttp("https://localhost/token")).toBe(false);
  });

  it("denies a lookalike host that merely starts with a loopback address", () => {
    expect(isLoopbackHttp("http://127.0.0.1.evil.test/token")).toBe(false);
    expect(isLoopbackHttp("http://localhost.evil.test/token")).toBe(false);
    expect(isLoopbackHttp("http://127.0.0.1@evil.test/token")).toBe(false);
  });

  it("denies anything that is not a parseable URL, and other schemes", () => {
    expect(isLoopbackHttp("not a url")).toBe(false);
    expect(isLoopbackHttp("")).toBe(false);
    expect(isLoopbackHttp("ftp://localhost/token")).toBe(false);
  });
});
