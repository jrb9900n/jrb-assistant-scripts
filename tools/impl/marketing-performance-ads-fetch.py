"""
Standalone read-only Google Ads fetcher for the Marketing Performance Report
(see marketing-performance-report.js).

Deliberately does NOT re-implement Google Ads OAuth/API access in Node. The
separate `google-ads-agent` Python daemon (C:\\Users\\Assistant\\google-ads-agent,
not part of this repo) already has a working developer token + refresh token
for the live JRB Google Ads account and a tested `GoogleAdsTools` wrapper
(tools/google_ads.py) -- this script imports that class directly via
sys.path rather than duplicating the OAuth plumbing (and a second place for
those credentials to go stale) inside JRBAgent. Read-only: only ever calls
get_campaign_performance, never a mutate/write method.

Usage: python marketing-performance-ads-fetch.py <days_back>
Prints exactly one line of JSON to stdout:
  {"campaigns": [...], "period_days": N, "count": N}
  or {"error": "..."} on any failure (missing daemon, API error, etc.)
"""
import sys
import json

GOOGLE_ADS_AGENT_DIR = "C:/Users/Assistant/google-ads-agent"


def main():
    days_back = 7
    if len(sys.argv) > 1:
        try:
            days_back = int(sys.argv[1])
        except ValueError:
            pass
    try:
        sys.path.insert(0, GOOGLE_ADS_AGENT_DIR)
        from tools.google_ads import GoogleAdsTools

        with open(f"{GOOGLE_ADS_AGENT_DIR}/config/config.json") as f:
            config = json.load(f)

        ads = GoogleAdsTools(config)
        result = ads.get_campaign_performance(days_back=days_back)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
