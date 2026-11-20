<?php
// Optional CLI runner when the hosting blocks public wp-cron.php requests.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
if (PHP_VERSION_ID < 70300) { fwrite(STDERR, "WP_PHP_73_REQUIRED\n"); exit(1); }
$loader = isset($argv[1]) ? realpath($argv[1]) : false;
if (!$loader || basename($loader) !== 'wp-load.php' || !is_file($loader)) {
    fwrite(STDERR, "Usage: php run.php /absolute/site/path/wp-load.php\n"); exit(1);
}
if (!defined('DISABLE_WP_CRON')) { define('DISABLE_WP_CRON', true); }
if (!defined('DOING_CRON')) { define('DOING_CRON', true); }
// Select the public source before Multisite loads per-site plugins.
$_SERVER['HTTP_HOST'] = 'energo-365.ru';
$_SERVER['SERVER_NAME'] = 'energo-365.ru';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
require $loader;
try {
    if (empty($GLOBALS['boykov_leads_plugin'])) { throw new RuntimeException('PLUGIN_NOT_ACTIVE'); }
    $result = $GLOBALS['boykov_leads_plugin']->run();
    echo wp_json_encode($result)."\n";
    exit(!empty($result['busy']) || !empty($result['heartbeat_ok']) ? 0 : 1);
} catch (Throwable $error) {
    fwrite(STDERR, "WP_DELIVERY_FAILED\n"); exit(1);
}
