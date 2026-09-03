#!/usr/bin/env python3
"""Google Ads API bridge (reporting + a narrow set of mutate operations),
invoked by tools/impl/google-ads.js.

Google's REST interface for the Ads API 404s ("Method not found") on every
canonical method as of 2026-08-26 -- confirmed live against a real OAuth
token with the correct 'adwords' scope, across every currently-supported
version (v22-v26). The officially-supported path is the google-ads Python
client (gRPC-based), already proven live in the sibling google-ads-agent
project (same credentials, reused here). This script is the smallest bridge
that reuses that proven path from JRBAgent's Node.js codebase.

Implements read (GAQL search) queries plus a deliberately narrow set of
mutate operations -- pause/enable a keyword, adjust a campaign's daily
budget -- added after an explicit scope decision (2026-09-03, Michael: "google
ads mutate is fine") to close the gap where the Teams bot could only describe
a fix (e.g. "here are 7 keywords to pause") instead of making it. Still
deliberately does NOT include bid changes or campaign/ad group/ad creation --
those are separate, larger-blast-radius operations with no immediate driving
need. The safety boundary is this script's function list, not the OAuth
token (which has always had full write access): see
tools/impl/google-ads.js's header and the mutate tool descriptions in
tools/registry.js for how a caller is expected to confirm before using them.

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
        # amount_micros is in millionths of the account currency; guard with
        # `is not None` so a legitimate 0-micros budget returns 0.0 rather
        # than None (a plain falsy check would mishandle the zero case).
        "dailyBudgetUsd": round(r.campaign_budget.amount_micros / 1e6, 2) if r.campaign_budget.amount_micros is not None else None,
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
        # See list_campaigns for the `is not None` rationale.
        "dailyBudgetUsd": round(r.campaign_budget.amount_micros / 1e6, 2) if r.campaign_budget.amount_micros is not None else None,
        "impressions": r.metrics.impressions,
        "clicks": r.metrics.clicks,
        "costUsd": round(r.metrics.cost_micros / 1e6, 2),
        "conversions": round(r.metrics.conversions, 2),
        "conversionsValue": round(r.metrics.conversions_value, 2),
        # cost_per_conversion is returned by the Google Ads API in the
        # account's currency units directly (NOT in micros), unlike
        # cost_micros / average_cpc which are in micros. Dividing by 1e6
        # would produce a value 1,000,000x too small (e.g. $50 CPA → $0.000050).
        "cpaUsd": round(r.metrics.cost_per_conversion, 2) if r.metrics.conversions > 0 else None,
        "ctr": round(r.metrics.ctr, 4),
        "avgCpcUsd": round(r.metrics.average_cpc / 1e6, 2),
    } for r in rows]


def get_keyword_performance(client, args):
    require_dates(args)
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign.name, ad_group.name, ad_group_criterion.criterion_id,
               ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
               ad_group_criterion.status,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM keyword_view
        WHERE segments.date BETWEEN '{args['startDate']}' AND '{args['endDate']}'
        {name_filter(args)}
        ORDER BY metrics.clicks DESC
        LIMIT 500
    """
    rows = ga_service.search(customer_id=CUSTOMER_ID, query=query)
    return [{
        # keywordId: pass this to pause_keyword/enable_keyword -- matching on
        # keyword text alone is ambiguous (the same text can exist in more
        # than one ad group), and pausing the wrong one is a real-money
        # mistake, not a cosmetic one.
        "keywordId": str(r.ad_group_criterion.criterion_id),
        "campaign": r.campaign.name,
        "adGroup": r.ad_group.name,
        "keyword": r.ad_group_criterion.keyword.text,
        "matchType": r.ad_group_criterion.keyword.match_type.name,
        "status": r.ad_group_criterion.status.name,
        "impressions": r.metrics.impressions,
        "clicks": r.metrics.clicks,
        "costUsd": round(r.metrics.cost_micros / 1e6, 2),
        "conversions": round(r.metrics.conversions, 2),
    } for r in rows]


# ── Mutate operations (added: pause/enable a keyword, adjust a campaign's
# daily budget) ─────────────────────────────────────────────────────────────
# Ported from the sibling google-ads-agent project's already-proven
# GoogleAdsTools.pause_keyword/enable_keyword/adjust_campaign_budget (same
# OAuth grant, same account) -- see tools/impl/google-ads.js's header for the
# scope decision this makes deliberately, and why it stops here (no bid
# changes, no campaign/ad group/ad creation in this first pass).

def _require_numeric_id(value, label):
    # GAQL has no bind-parameter API for search() -- IDs are interpolated
    # directly into the query string, same as name_filter() above does for
    # free text (which escapes quotes/backslashes for the same reason).
    # Google Ads criterion/campaign IDs are always plain digit strings, so
    # rejecting anything else closes this off rather than escaping it: an
    # unvalidated `"123 OR 1=1"` here would turn `WHERE ...criterion_id = 123
    # OR 1=1` into a match-everything clause, and the first row GAQL happens
    # to return would get paused/re-budgeted instead of the intended one.
    s = str(value)
    if not s.isdigit():
        raise ValueError(f"{label} must be a numeric ID, got: {value!r}")
    return s


def _keyword_resource_name(ga_service, keyword_id):
    # criterion_id is only unique WITHIN an ad group, not account-wide --
    # that's exactly why AdGroupCriterion's real resource name is the
    # composite "{ad_group_id}~{criterion_id}", and why every other GAQL
    # query in this file that touches ad_group_criterion also selects
    # campaign/ad_group alongside it. Querying by criterion_id alone and
    # taking the first row (the original version of this function) could
    # silently resolve to a different ad group's same-numbered keyword and
    # pause/enable the wrong one with zero error -- refuse on any ambiguity
    # instead of guessing which row is "the" one.
    keyword_id = _require_numeric_id(keyword_id, "keywordId")
    query = f"""
        SELECT ad_group_criterion.resource_name, campaign.name, ad_group.name
        FROM ad_group_criterion
        WHERE ad_group_criterion.criterion_id = {keyword_id}
    """
    rows = list(ga_service.search(customer_id=CUSTOMER_ID, query=query))
    if not rows:
        return None
    if len(rows) > 1:
        locations = ", ".join(f"{r.campaign.name} / {r.ad_group.name}" for r in rows)
        raise ValueError(
            f"keywordId {keyword_id} is ambiguous -- it matches {len(rows)} ad groups: {locations}. "
            f"Re-check google_ads_get_keyword_performance's campaign/adGroup fields for the intended one."
        )
    return rows[0].ad_group_criterion.resource_name


def _set_keyword_status(client, args, status):
    keyword_id = args["keywordId"]
    ga_service = client.get_service("GoogleAdsService")
    resource_name = _keyword_resource_name(ga_service, keyword_id)
    if not resource_name:
        raise ValueError(f"No keyword found with id {keyword_id}")

    criterion_service = client.get_service("AdGroupCriterionService")
    criterion_op = client.get_type("AdGroupCriterionOperation")
    criterion = criterion_op.update
    criterion.resource_name = resource_name
    criterion.status = client.enums.AdGroupCriterionStatusEnum[status]
    criterion_op.update_mask.paths.append("status")
    criterion_service.mutate_ad_group_criteria(customer_id=CUSTOMER_ID, operations=[criterion_op])
    return {"keywordId": keyword_id, "newStatus": status, "reason": args.get("reason", "")}


def pause_keyword(client, args):
    return _set_keyword_status(client, args, "PAUSED")


def enable_keyword(client, args):
    return _set_keyword_status(client, args, "ENABLED")


def adjust_campaign_budget(client, args):
    campaign_id = _require_numeric_id(args["campaignId"], "campaignId")
    new_budget_usd = args["newDailyBudgetUsd"]
    ga_service = client.get_service("GoogleAdsService")
    query = f"""
        SELECT campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = {campaign_id}
        AND campaign.status != 'REMOVED'
    """
    budget_resource, old_budget_micros = None, None
    for row in ga_service.search(customer_id=CUSTOMER_ID, query=query):
        budget_resource = row.campaign_budget.resource_name
        old_budget_micros = row.campaign_budget.amount_micros
    if not budget_resource:
        raise ValueError(f"No campaign found with id {campaign_id}")

    # A campaign_budget resource can be shared across more than one campaign
    # (a legitimate, common Google Ads setup) -- mutating it by resource_name
    # would silently change another campaign's spend cap too, with nothing in
    # the confirmation Michael saw (code-approval.js's describeAction only
    # names the one campaign requested) hinting that was about to happen. No
    # override flag here on purpose -- the model's tool_use input isn't a
    # trusted channel (whatever it passes gets stored verbatim and replayed
    # as-is once Michael confirms, see code-approval.js's
    # executeApprovedAction), so a bypass flag would just be something the
    # model could set on the very first call, before any real human ever saw
    # this warning. A genuinely-wanted shared-budget change is a manual Ads
    # UI action, not this tool.
    sharing_query = f"""
        SELECT campaign.id, campaign.name
        FROM campaign
        WHERE campaign_budget.resource_name = '{budget_resource}'
        AND campaign.status != 'REMOVED'
    """
    sharing_campaigns = [
        {"id": str(r.campaign.id), "name": r.campaign.name}
        for r in ga_service.search(customer_id=CUSTOMER_ID, query=sharing_query)
    ]
    other_campaigns = [c for c in sharing_campaigns if c["id"] != campaign_id]
    if other_campaigns:
        names = ", ".join(f'{c["name"]} (id {c["id"]})' for c in other_campaigns)
        raise ValueError(
            f"Campaign {campaign_id}'s budget is shared with {len(other_campaigns)} other campaign(s): "
            f"{names}. Changing it would change their daily budget too -- this tool refuses shared-budget "
            f"changes; do this manually in the Ads UI if it's genuinely intended."
        )

    budget_service = client.get_service("CampaignBudgetService")
    budget_op = client.get_type("CampaignBudgetOperation")
    budget_op.update.resource_name = budget_resource
    budget_op.update.amount_micros = int(round(new_budget_usd * 1e6))
    budget_op.update_mask.paths.append("amount_micros")
    budget_service.mutate_campaign_budgets(customer_id=CUSTOMER_ID, operations=[budget_op])
    return {
        "campaignId": campaign_id,
        "previousDailyBudgetUsd": round(old_budget_micros / 1e6, 2) if old_budget_micros is not None else None,
        "newDailyBudgetUsd": round(new_budget_usd, 2),
        "reason": args.get("reason", ""),
    }


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
    "pause_keyword": pause_keyword,
    "enable_keyword": enable_keyword,
    "adjust_campaign_budget": adjust_campaign_budget,
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
