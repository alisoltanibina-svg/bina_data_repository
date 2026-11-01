"""Database namespaces. Table names and API field names remain unchanged."""

TABLE_SCHEMAS = {
    **dict.fromkeys((
        "topics", "kdescription", "kindicator_score", "trend_score",
        "province_pop", "clusters", "provinces", "pyramid",
    ), "analytics"),
    **dict.fromkeys((
        "users", "registration_requests", "sessions", "otp_challenges",
        "captcha_challenges", "login_failures", "profile_revisions",
        "account_status_events",
    ), "accounts"),
    **dict.fromkeys((
        "support_tickets", "support_messages", "support_status_events",
        "support_attachments",
    ), "support"),
    **dict.fromkeys((
        "poi_control", "poi_boundaries", "poi_categories", "poi_jobs",
        "poi_segments", "poi_places", "poi_place_categories", "poi_detail_tasks",
        "poi_requests", "poi_duplicate_reviews", "poi_source_datasets",
        "poi_settlements", "poi_coverage_plans", "poi_coverage_tiles",
        "poi_coverage_circles", "poi_coverage_contributions", "poi_preparations",
    ), "poi"),
    "site_settings": "app",
}

APPLICATION_SCHEMAS = frozenset(TABLE_SCHEMAS.values())
