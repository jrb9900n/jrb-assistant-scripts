#!/usr/bin/env python3
"""Read-only Google Ads API bridge, invoked by tools/impl/google-ads.js.

Google's REST interface for the Ads API 404s ("Method not found") on every
canonical method as of 2026-08-26 -- confirmed live against a real OAuth
token with the correct 'adwords' scope, across every currently-supported
version (v22-v26). The officially-supported path is the google-ads Python
client (gRPC-based), already proven live in the sibling google-ads-agent
project (same credentials, reused here). This script is the smallest bridge
that reuses that proven path from JRBAgent's Node.js codebase.

Deliberately implements ONLY read (GAQL search) queries -- no mutate
operations -- even though the underlying OAuth grant (reused from
google-ads-agent) also has write access there. The safety boundary is this
script's function list, not the token: see tools/impl/google-ads.js's header.

Invoked as: python google_ads_bridge.py <command> '<json-args>'
Prints one JSON object to stdout: {"ok": true, "data": ...} or
{"ok": false, "error": "..."}. Credentials come from environment variables
(GOOGLE_ADS_CLIENT_ID/CLIENT_SECRET/DEVELOPER_TOKEN/REFRESH_TOKEN/
LOGIN_CUSTOMER_ID) injected by start-agent.ps1 from Credential Manager --
never read from google-ads-agent's config file path.
"""
import sys
import json
import os

from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

# J.R. Boehlke's Google Ads account, under the MCC (GOOGLE_ADS_LOGIN_CUSTOMER_ID).
# Not secret -- same convention as QB_REALM_ID being hardcoded in qb-token.js.
CUSTOMER_ID = "3916564896"


def get_client():
    config = {
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "login_customer_id": os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
        "use_proto_plus": True,
    }
    # v23 matches the version the already-live google-ads-agent project loads
    # with the same installed client library version (google-ads>=25.0.0).
    return GoogleAdsClient.load_from_dict(config, version="v23")


def name_filter(args):
    needle = args.get("nameContains")
    if not needle:
        return ""
    escaped = needle.replace("\\", "\\\\").replace("'", "\\'")
    return f"AND campaign.name LIKE '%{escaped}%'"


def require_dates(args):
    if not args.get("startDate") or not args.get("endDate"):
        raise ValueError("startDate and endDate (YYYY-MM-DD) are required")


def list_campaigns(client, args):
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        {name_filter(args)}
        ORDER BY campaign.name
    """
    rows = ga_service.search(customer_id=CUSTOMER_ID, query=query)
    return [{
        "id": str(r.campaign.id),
        "name": r.campaign.name,
        "status": r.campaign.status.name,
        "channelType": r.campaign.advertising_channel_type.name,
        "dailyBudgetUsd": round(r.campaign_budget.amount_micros / 1e6, 2) if r.campaign_budget.amount_micros else None,
    } for r in rows]


def get_campaign_metrics(client, args):
    require_dates(args)
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros,
               metrics.impressions, metrics.clicks, metrics.cost_micros,
               metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc,
               metrics.cost_per_conversion
        FROM campaign
        WHERE segments.date BETWEEN '{args['startDate']}' AND '{args['endDate']}'
        {name_filter(args)}
        ORDER BY metrics.cost_micros DESC
    """
    rows = ga_service.search(customer_id=CUSTOMER_ID, query=query)
    return [{
        "id": str(r.campaign.id),
        "name": r.campaign.name,
        "status": r.campaign.status.name,
        "dailyBudgetUsd": round(r.campaign_budget.amount_micros / 1e6, 2) if r.campaign_budget.amount_micros else None,
        "impressions": r.metrics.impressions,
        "clicks": r.metrics.clicks,
        "costUsd": round(r.metrics.cost_micros / 1e6, 2),
        "conversions": round(r.metrics.conversions, 2),
        "conversionsValue": round(r.metrics.conversions_value, 2),
        "cpaUsd": round(r.metrics.cost_per_conversion / 1e6, 2) if r.metrics.conversions > 0 else None,
        "ctr": round(r.metrics.ctr, 4),
        "avgCpcUsd": round(r.metrics.average_cpc / 1e6, 2),
    } for r in rows]


def get_keyword_performance(client, args):
    require_dates(args)
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM keyword_view
        WHERE segments.date BETWEEN '{args['startDate']}' AND '{args['endDate']}'
        {name_filter(args)}
        ORDER BY metrics.clicks DESC
        LIMIT 500
    """
    rows = ga_service.search(customer_id=CUSTOMER_ID, query=query)
    return [{
        "campaign": r.campaign.name,
        "adGroup": r.ad_group.name,
        "keyword": r.ad_group_criterion.keyword.text,
        "matchType": r.ad_group_criterion.keyword.match_type.name,
        "impressions": r.metrics.impressions,
        "clicks": r.metrics.clicks,
        "costUsd": round(r.metrics.cost_micros / 1e6, 2),
        "conversions": round(r.metrics.conversions, 2),
    } for r in rows]


def get_lead_conversions(client, args):
    require_dates(args)
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign.name, segments.conversion_action_name, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '{args['startDate']}' AND '{args['endDate']}'
        AND metrics.conversions > 0
        {name_filter(args)}
        ORDER BY metrics.conversions DESC
    """
    rows = ga_service.search(customer_id=CUSTOMER_ID, query=query)
    return [{
        "campaign": r.campaign.name,
        "conversionAction": r.segments.conversion_action_name,
        "conversions": round(r.metrics.conversions, 2),
        "conversionsValue": round(r.metrics.conversions_value, 2),
    } for r in rows]


COMMANDS = {
    "list_campaigns": list_campaigns,
    "get_campaign_metrics": get_campaign_metrics,
    "get_keyword_performance": get_keyword_performance,
    "get_lead_conversions": get_lead_conversions,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"ok": False, "error": f"Unknown command. Expected one of: {list(COMMANDS)}"}))
        sys.exit(1)
    command = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    try:
        client = get_client()
        data = COMMANDS[command](client, args)
        print(json.dumps({"ok": True, "data": data}))
    except GoogleAdsException as ex:
        print(json.dumps({"ok": False, "error": str(ex)}))
        sys.exit(1)
    except Exception as ex:
        print(json.dumps({"ok": False, "error": str(ex)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
