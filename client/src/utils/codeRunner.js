/**
 * Code execution via Judge0 (free public instance).
 * Docs: https://ce.judge0.com/
 *
 * Flow:
 *  1. POST /submissions → get token
 *  2. GET  /submissions/:token → poll until status != "Processing" / "In Queue"
 */

import axios from "axios";
import { JUDGE0_LANGUAGE_IDS } from "./constants";

const JUDGE0_BASE = "https://judge0-ce.p.rapidapi.com";

// If you have a RapidAPI key, set it here or via env variable.
// Without a key the free tier has very tight rate limits.
const RAPIDAPI_KEY = import.meta.env.VITE_RAPIDAPI_KEY || "";

const headers = RAPIDAPI_KEY
  ? {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
      "Content-Type": "application/json",
    }
  : { "Content-Type": "application/json" };

const BASE_URL = RAPIDAPI_KEY
  ? JUDGE0_BASE
  : "https://ce.judge0.com"; // open fallback (no auth needed)

/**
 * Submit code to Judge0 and wait for the result.
 * @param {string} code - Source code to run.
 * @param {string} language - Monaco language id.
 * @param {string} [stdin=""] - Optional stdin.
 * @returns {Promise<{ stdout, stderr, compile_output, status }>}
 */
export async function runCode(code, language, stdin = "") {
  const languageId = JUDGE0_LANGUAGE_IDS[language];
  if (!languageId) {
    throw new Error(`Code execution is not supported for '${language}'.`);
  }

  // 1. Submit
  const submitRes = await axios.post(
    `${BASE_URL}/submissions?base64_encoded=true&wait=false`,
    {
      source_code: btoa(unescape(encodeURIComponent(code))),
      language_id: languageId,
      stdin: btoa(stdin),
    },
    { headers }
  );

  const token = submitRes.data.token;
  if (!token) throw new Error("No submission token received.");

  // 2. Poll until done (max 15 attempts × 1s = 15s)
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const res = await axios.get(
      `${BASE_URL}/submissions/${token}?base64_encoded=true`,
      { headers }
    );
    const data = res.data;

    // Status IDs 1 (In Queue) and 2 (Processing) → keep polling
    if (data.status?.id <= 2) continue;

    return {
      stdout: safeDecode(data.stdout),
      stderr: safeDecode(data.stderr),
      compile_output: safeDecode(data.compile_output),
      status: data.status?.description || "Unknown",
      time: data.time,
      memory: data.memory,
    };
  }

  throw new Error("Execution timed out.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeDecode(b64) {
  if (!b64) return "";
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return b64;
  }
}
