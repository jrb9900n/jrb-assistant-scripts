"""
Standalone read-only Google Ads fetcher for the Marketing Performance Report
(see marketing-performance-report.js).

Deliberately does NOT re-implement Google Ads OAuth/API access in Node. The
separate `google-ads-agent` Python daemon (configured via
GOOGLE_ADS_AGENT_DIR, not hardcoded) already has a working developer token +
refresh token for the live JRB Google Ads account and a tested
`GoogleAdsTools` wrapper (tools/google_ads.py) -- this script imports that
class directly via sys.path rather than duplicating the OAuth plumbing (and a
second place for those credentials to go stale) inside JRBAgent. Read-only:
only ever calls get_campaign_performance, never a mutate/write method.

Required environment variable:
  GOOGLE_ADS_AGENT_DIR  Absolute path to the google-ads-agent checkout whose
                        tools/google_ads.py and config/config.json we import.
                        The script exits with a non-zero status and a clear
                        error message if this variable is absent or points to
                        a non-existent directory, so misconfigured deployments
                        fail loudly at invocation time rather than silently
                        returning {"error": "..."} every run.

Usage: python marketing-performance-ads-fetch.py <days_back>
Prints exactly one line of JSON to stdout:
  {"campaigns": [...], "period_days": N, "count": N}
  or {"error": "..."} on any failure (missing daemon, API error, etc.)
"""
import sys
import os
import json


def _get_google_ads_agent_dir():
    """
    Return the google-ads-agent directory from the environment, or exit with a
    clear, actionable error message if it is missing or non-existent.

    Deliberately raises SystemExit (non-zero) rather than printing
    {"error": ...} so that the Node.js caller's `execFileAsync` receives a
    non-zero exit code, which is treated as a hard failure rather than a soft
    "ads unavailable" degradation. This makes misconfiguration visible in logs
    and monitoring rather than silently suppressing the ads section every run.
    """
    agent_dir = os.environ.get("GOOGLE_ADS_AGENT_DIR", "").strip()
    if not agent_dir:
        sys.stderr.write(
            "[marketing-performance-ads-fetch] FATAL: GOOGLE_ADS_AGENT_DIR "
            "environment variable is not set.\n"
            "Set it to the absolute path of the google-ads-agent checkout, e.g.:\n"
            "  GOOGLE_ADS_AGENT_DIR=/home/user/google-ads-agent\n"
        )
        sys.exit(1)
    if not os.path.isdir(agent_dir):
        sys.stderr.write(
            f"[marketing-performance-ads-fetch] FATAL: GOOGLE_ADS_AGENT_DIR "
            f"points to a non-existent directory: {agent_dir!r}\n"
            "Update the environment variable to the correct path.\n"
        )
        sys.exit(1)
    return agent_dir


def main():
    # Resolve and validate the agent directory before doing anything else so
    # that a misconfigured deployment fails at startup, not mid-report.
    google_ads_agent_dir = _get_google_ads_agent_dir()

    days_back = 7
    if len(sys.argv) > 1:
        try:
            days_back = int(sys.argv[1])
        except ValueError:
            pass
    try:
        sys.path.insert(0, google_ads_agent_dir)
        from tools.google_ads import GoogleAdsTools

        config_path = os.path.join(google_ads_agent_dir, "config", "config.json")
        with open(config_path) as f:
            config = json.load(f)

        ads = GoogleAdsTools(config)
        result = ads.get_campaign_performance(days_back=days_back)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
