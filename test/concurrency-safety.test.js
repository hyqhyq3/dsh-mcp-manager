import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isToolConcurrencySafe } from '../lib/index.js';

// Real tool names as exposed by BurpMCP-Ultra (150 tools); the two groups below
// are the ones whose classification actually matters: state-changing actions must
// stay serial, pure reads/computations may run in parallel.
const MUST_BE_SERIAL = [
  'burp_shutdown', 'burp_task_engine_set', 'burp_import_project_config', 'burp_import_user_config',
  'scanner_start_audit', 'scanner_start_crawl', 'scanner_task_delete', 'scanner_register_check',
  'scanner_unregister_check', 'scanner_create_issue', 'scanner_generate_report',
  'proxy_intercept_enable', 'proxy_intercept_disable', 'proxy_annotate', 'proxy_set_request_rule',
  'proxy_remove_rule', 'proxy_auto_auth', 'scope_include', 'scope_exclude',
  'repeater_send', 'intruder_send', 'intruder_register_payload_processor',
  'sitemap_add_request', 'sitemap_add_issue', 'findings_add', 'bambda_import',
  'persistence_store', 'persistence_delete', 'preference_store',
  'http_set_traffic_rule', 'http_remove_traffic_rule', 'config_proxy_listener_add',
  'config_proxy_listener_remove', 'config_match_replace_add', 'config_match_replace_remove',
  'config_upstream_proxy_set', 'session_create_token_rule', 'session_remove_rule',
  'websocket_create', 'websocket_send_text', 'websocket_close', 'websocket_set_intercept_rule',
  'comparer_send', 'decoder_send', 'organizer_send',
  'scancheck_create_passive', 'scancheck_create_active', 'scancheck_remove',
  'bcheck_create', 'bcheck_import', 'bcheck_remove', 'api_import_openapi',
  'jwt_attack', 'idor_hunt', 'auth_diff', 'access_control_sweep', 'injection_probe',
  'http_fuzz', 'http_race', 'http_send_request', 'http_send_requests_parallel',
  'log_message', 'log_event', 'events_subscribe', 'events_unsubscribe', 'events_clear',
  // These issue real requests against the target, so they carry side effects.
  'cors_probe', 'graphql_probe', 'recon_param_mine', 'recon_content_discovery',
  // Unknown vocabulary must not be assumed safe.
  'totally_unknown_tool',
];

const MUST_BE_PARALLEL = [
  'burp_version', 'project_info', 'extension_info', 'burp_task_engine_state',
  'burp_export_project_config', 'burp_export_user_config', 'burp_command_line_args',
  'proxy_history', 'proxy_history_search', 'proxy_intercept_status', 'proxy_list_rules',
  'proxy_websocket_history', 'http_list_traffic_rules', 'http_cookie_jar_get',
  'scanner_task_status', 'scanner_task_list', 'scanner_get_all_issues',
  'sitemap_query', 'sitemap_get_issues', 'scope_check', 'scope_get_config',
  'collaborator_poll', 'collaborator_server_info', 'collaborator_get_secret',
  'organizer_get_items', 'websocket_list', 'websocket_get_messages',
  'analyze_request', 'analyze_response', 'analyze_find_reflected', 'analyze_extract_params',
  'analyze_insertion_points', 'analyze_diff', 'analyze_response_body_search',
  'util_hash', 'util_base64_encode', 'util_base64_decode', 'util_url_encode', 'util_url_decode',
  'util_html_encode', 'util_decode_smart', 'util_jwt_decode', 'util_random_string', 'util_random_bytes',
  'util_compress', 'util_decompress', 'config_proxy_listeners_list', 'config_match_replace_list',
  'session_list_rules', 'bcheck_list', 'bcheck_templates', 'scancheck_list', 'scancheck_templates',
  'passive_intel', 'findings_list', 'recon_js_endpoints', 'recon_fingerprint',
  'events_get', 'events_get_by_type', 'persistence_get', 'persistence_list', 'preference_get',
  'ai_status', 'ai_prompt',
];

describe('isToolConcurrencySafe', () => {
  it('keeps state-changing tools serial', () => {
    const wrong = MUST_BE_SERIAL.filter((name) => isToolConcurrencySafe(name));
    assert.deepEqual(wrong, [], `these must not be marked concurrency-safe: ${wrong.join(', ')}`);
  });

  it('lets pure reads and computations run in parallel', () => {
    const wrong = MUST_BE_PARALLEL.filter((name) => !isToolConcurrencySafe(name));
    assert.deepEqual(wrong, [], `these should be concurrency-safe: ${wrong.join(', ')}`);
  });

  it('reads every name segment, because the first one is a namespace', () => {
    // `proxy` is not a verb; the decision has to come from `history` / `set_…`.
    assert.equal(isToolConcurrencySafe('proxy_history'), true);
    assert.equal(isToolConcurrencySafe('proxy_set_request_rule'), false);
  });

  it('matches writes before reads so a read-looking segment cannot leak one through', () => {
    // `import` (write) must win over the surrounding words.
    assert.equal(isToolConcurrencySafe('api_import_openapi'), false);
  });

  it('resolves vocabulary that is ambiguous on its own via explicit exceptions', () => {
    // `intercept` is a query in one tool and a toggle in another.
    assert.equal(isToolConcurrencySafe('proxy_intercept_status'), true);
    assert.equal(isToolConcurrencySafe('proxy_intercept_enable'), false);
    // `diff` is a pure compare in one tool and a request replay in another.
    assert.equal(isToolConcurrencySafe('analyze_diff'), true);
    assert.equal(isToolConcurrencySafe('auth_diff'), false);
  });

  it('stays conservative for empty or unknown names', () => {
    assert.equal(isToolConcurrencySafe(''), false);
    assert.equal(isToolConcurrencySafe(undefined), false);
    assert.equal(isToolConcurrencySafe('zzz_qqq'), false);
  });
});
