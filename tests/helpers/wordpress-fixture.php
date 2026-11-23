<?php
// Minimal WordPress API adapter. Queue tests use a real disposable MySQL database.
define('ABSPATH', '/fixture/');
define('DB_NAME', getenv('WP_TEST_MYSQL_DATABASE') ?: 'boykov_wp_test_unit');
define('ARRAY_A', 'ARRAY_A');
define('WPCF7_VERSION', '5.7.4');
class WPCF7_Submission {}
class WP_Error {}
$GLOBALS['options'] = array();
$GLOBALS['hooks'] = array();
$GLOBALS['blog_id'] = 1;
$GLOBALS['site_options'] = array();
$GLOBALS['network_options'] = array();
$GLOBALS['blog_stack'] = array();
$GLOBALS['cron'] = array();
function add_action($name, $callback, $priority = 10, $accepted = 1) { $GLOBALS['hooks'][$name] = array($callback, $priority, $accepted); }
function add_filter($name, $callback) {}
function register_activation_hook($file, $callback) {}
function register_deactivation_hook($file, $callback) {}
function is_wp_error($value) { return $value instanceof WP_Error; }
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
function wp_parse_url($url, $component = -1) { return parse_url($url, $component); }
function get_current_blog_id() { return $GLOBALS['blog_id']; }
function home_url($path = '/') {
    $host = isset($GLOBALS['site_hosts'][$GLOBALS['blog_id']]) ? $GLOBALS['site_hosts'][$GLOBALS['blog_id']] : (getenv('WP_FIXTURE_HOST') ?: 'energo-365.ru');
    return 'https://'.$host.$path;
}
function get_site_url($id, $path = '') { return 'https://'.$GLOBALS['site_hosts'][$id].'/'.$path; }
function site_url($path = '') { return home_url('/'.$path); }
function wp_remote_retrieve_response_code($r) { return isset($r['response']['code']) ? $r['response']['code'] : ''; }
function wp_remote_retrieve_body($r) { return isset($r['body']) ? $r['body'] : ''; }
function get_option($key, $default = false) {
    $o = get_current_blog_id() === 1 ? $GLOBALS['options'] : (isset($GLOBALS['site_options'][get_current_blog_id()]) ? $GLOBALS['site_options'][get_current_blog_id()] : array());
    return isset($o[$key]) ? $o[$key] : $default;
}
function update_option($key, $value, $autoload = null) {
    if (get_current_blog_id() === 1) { $GLOBALS['options'][$key] = $value; }
    else { $GLOBALS['site_options'][get_current_blog_id()][$key] = $value; }
    return true;
}
function get_site_option($key, $default = false) { return isset($GLOBALS['network_options'][$key]) ? $GLOBALS['network_options'][$key] : $default; }
function update_site_option($key, $value) { $GLOBALS['network_options'][$key] = $value; return true; }
function plugin_basename($path) { return 'boykov-leads/boykov-leads.php'; }
function get_current_network_id() { return 1; }
function get_sites($args) {
    if ($args['network_id'] !== 1) { throw new RuntimeException('WRONG_NETWORK'); }
    return array_slice(array_keys($GLOBALS['site_hosts']), $args['offset'], $args['number']);
}
function switch_to_blog($id) {
    $GLOBALS['blog_stack'][] = get_current_blog_id(); $GLOBALS['blog_id'] = (int) $id;
    if (isset($GLOBALS['wpdb'])) { $GLOBALS['wpdb']->prefix = $id === 1 ? 'wp_' : 'wp_'.$id.'_'; }
}
function restore_current_blog() {
    $id = array_pop($GLOBALS['blog_stack']); $GLOBALS['blog_id'] = $id;
    if (isset($GLOBALS['wpdb'])) { $GLOBALS['wpdb']->prefix = $id === 1 ? 'wp_' : 'wp_'.$id.'_'; }
}
function wp_generate_uuid4() {
    $b = random_bytes(16); $b[6] = chr((ord($b[6]) & 15) | 64); $b[8] = chr((ord($b[8]) & 63) | 128);
    $h = bin2hex($b); return substr($h,0,8).'-'.substr($h,8,4).'-'.substr($h,12,4).'-'.substr($h,16,4).'-'.substr($h,20);
}
function current_user_can($cap) { return $cap === 'manage_network_options' ? !empty($GLOBALS['can_manage_network']) : !empty($GLOBALS['can_manage']); }
function check_admin_referer($action) { if (empty($GLOBALS['nonce_ok'])) { throw new RuntimeException('NONCE_REQUIRED'); } }
function wp_unslash($value) { return $value; }
function wp_die($message, $title = '', $args = array()) { throw new RuntimeException('WP_DIE:'.$message); }
function esc_html($text) { return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8'); }
function esc_attr($text) { return esc_html($text); }
function esc_url($text) { return esc_html($text); }
function admin_url($path) { return 'https://energo-365.ru/wp-admin/'.$path; }
function wp_nonce_field($action) { echo '<input type="hidden" name="_wpnonce" value="fixture-nonce">'; }
function submit_button($text, $type = 'primary', $name = 'submit', $wrap = true) { echo '<button>'.esc_html($text).'</button>'; }
function add_options_page() {}
function is_multisite() { return !empty($GLOBALS['multisite']); }
function wp_next_scheduled($hook) { return isset($GLOBALS['cron'][get_current_blog_id()][$hook]) ? $GLOBALS['cron'][get_current_blog_id()][$hook] : false; }
function wp_schedule_event($timestamp, $interval, $hook, $args, $error) {
    $GLOBALS['scheduled'] = array($timestamp,$interval,$hook); $GLOBALS['cron'][get_current_blog_id()][$hook] = $timestamp; return true;
}
function wp_clear_scheduled_hook($hook) { $GLOBALS['cleared'] = $hook; unset($GLOBALS['cron'][get_current_blog_id()][$hook]); }
function wp_safe_remote_post($url, $args) {
    $GLOBALS['request'] = array($url, $args);
    if (isset($GLOBALS['statistics_transport'])) { return call_user_func($GLOBALS['statistics_transport'], $url, $args); }
    if (!empty($GLOBALS['network_transport'])) {
        $body = json_decode($args['body'], true);
        $GLOBALS['network_tokens'][] = $args['headers']['Authorization'];
        if (substr($url, -10) === '/heartbeat') {
            $GLOBALS['network_heartbeats'][] = $body;
            return array('response'=>array('code'=>200),'body'=>wp_json_encode(array('ok'=>true,'siteId'=>'fixture')));
        }
        $host = wp_parse_url($body['pageUrl'], PHP_URL_HOST);
        $GLOBALS['network_payloads'][] = array('host'=>$host,'event'=>$body['eventId']);
        if ($host === 'lp.energo-365.ru') { return array('response'=>array('code'=>503),'body'=>'{}'); }
        return array('response'=>array('code'=>201),'body'=>wp_json_encode(array('ok'=>true,'siteId'=>'fixture','eventId'=>$body['eventId'],'id'=>wp_generate_uuid4())));
    }
    if (isset($GLOBALS['transport_response'])) { return $GLOBALS['transport_response']; }
    $base = getenv('WP_FIXTURE_HUB');
    if (!$base) { return new WP_Error(); }
    $target = $base.wp_parse_url($url, PHP_URL_PATH);
    $headers = array(); foreach ($args['headers'] as $key => $value) { $headers[] = $key.': '.$value; }
    $context = stream_context_create(array('http' => array('method' => 'POST', 'header' => implode("\r\n", $headers),
        'content' => $args['body'], 'timeout' => $args['timeout'], 'ignore_errors' => true, 'follow_location' => 0)));
    $body = @file_get_contents($target, false, $context);
    if ($body === false) { return new WP_Error(); }
    $code = 0;
    foreach ($http_response_header as $header) { if (preg_match('~^HTTP/\S+ (\d+)~', $header, $match)) { $code = (int) $match[1]; } }
    return array('response' => array('code' => $code), 'body' => $body);
}

class Fixture_Form {
    public function title() { return 'Получить консультацию'; }
    public function id() { return 51; }
    public function scan_form_tags() { return array((object) array('name'=>'text-903','basetype'=>'text'),
        (object) array('name'=>'mask-101','basetype'=>'mask'), (object) array('name'=>'email-466','basetype'=>'email'),
        (object) array('name'=>'your-message','basetype'=>'textarea')); }
}
class Fixture_Submission {
    public $response = '';
    public function get_posted_data() { return array('text-903' => ' Тестовый клиент ', 'mask-101' => '+7 900 000-00-00',
        'email-466' => 'fixture@example.invalid', 'your-message'=>'Нужен расчёт',
        'checkbox-659' => array('Согласен'), 'Объект'=>array('Офис','Склад'),
        '_wpcf7'=>51, 'g-recaptcha-response'=>'captcha-private', 'api_token'=>'credential-private'); }
    public function get_meta($key) { return getenv('WP_FIXTURE_SOURCE_URL') ?: home_url('/service/?secret=not-for-hub#section'); }
    public function set_response($text) { $this->response = $text; }
}

class Fixture_DB {
    public $prefix = 'wp_';
    public $last_error = '';
    public $insert_id = 0;
    private $connection;
    public function __construct() {
        if (getenv('WP_TEST_MYSQL_SOCKET') || getenv('WP_TEST_MYSQL_PORT')) {
            if (!preg_match('/^boykov_wp_test_[A-Za-z0-9_]+$/D', DB_NAME)) { throw new RuntimeException('DISPOSABLE_TEST_DATABASE_REQUIRED'); }
            mysqli_report(MYSQLI_REPORT_OFF);
            $this->connection = new mysqli(getenv('WP_TEST_MYSQL_PORT') ? '127.0.0.1' : 'localhost', 'root', '', DB_NAME,
                (int) getenv('WP_TEST_MYSQL_PORT'), getenv('WP_TEST_MYSQL_SOCKET') ?: null);
            if ($this->connection->connect_errno) { throw new RuntimeException('MYSQL_CONNECT'); }
            $this->connection->set_charset('utf8mb4');
        }
    }
    public function suppress_errors($flag = true) { return false; }
    public function get_charset_collate() { return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'; }
    public function prepare($query, ...$args) {
        if (count($args) === 1 && is_array($args[0])) { $args = $args[0]; }
        $i=0;
        return preg_replace_callback('/%[sd]/', function ($match) use (&$i, $args) {
            $value=$args[$i++];
            return $match[0] === '%d' ? (string) (int) $value : "'".($this->connection ? $this->connection->real_escape_string((string) $value) : addslashes((string) $value))."'";
        }, $query);
    }
    public function query($query) {
        $this->last_error='';
        if (!$this->connection) { $this->last_error='No fixture database'; return false; }
        $r=$this->connection->query($query);
        if ($r===false) { $this->last_error=$this->connection->error; return false; }
        $this->insert_id=$this->connection->insert_id;
        return $r instanceof mysqli_result ? $r : $this->connection->affected_rows;
    }
    public function get_results($q, $mode = null) { $r=$this->query($q); return $r instanceof mysqli_result ? $r->fetch_all(MYSQLI_ASSOC) : null; }
    public function get_row($q, $mode = null) { $rows=$this->get_results($q); return $rows ? $rows[0] : null; }
    public function get_var($q) { $row=$this->get_row($q); return $row ? array_values($row)[0] : null; }
    public function insert($table, $data, $formats) {
        return $this->query($this->prepare('INSERT INTO `'.$table.'` (`'.implode('`,`', array_keys($data)).'`) VALUES ('.implode(',', $formats).')', array_values($data)));
    }
}

$wpdb = new Fixture_DB();
require dirname(__DIR__, 2).'/integrations/leads/wordpress/boykov-leads/boykov-leads.php';
$queue = new Boykov_Leads_Queue($wpdb);
$mode = isset($argv[1]) ? $argv[1] : '';
$input = json_decode(stream_get_contents(STDIN), true) ?: array();
$plugin = $GLOBALS['boykov_leads_plugin'];
$config = array('endpoint'=>'https://boykov-services.ru/hooks/leads/'.(isset($input['site']) ? $input['site'] : 'fixture'),
    'token'=>isset($input['token']) ? $input['token'] : str_repeat('a',64));

if ($mode === 'map') {
    echo wp_json_encode(Boykov_Leads_Payload::make(new Fixture_Form(), new Fixture_Submission(), 'cf7:fixture', 1795082400));
} elseif ($mode === 'ack') {
    echo wp_json_encode(Boykov_Leads_Payload::acknowledgement($input['response'], 'fixture', isset($input['event']) ? $input['event'] : null));
} elseif ($mode === 'endpoint') {
    try { echo wp_json_encode(Boykov_Leads_Payload::endpoint($input['url'])); } catch (Throwable $e) { echo 'false'; }
} elseif ($mode === 'transport') {
    Boykov_Leads_Plugin::http('https://boykov-services.ru/hooks/leads/fixture', '{}', 'test-key');
    echo wp_json_encode($GLOBALS['request']);
} elseif ($mode === 'access') {
    $GLOBALS['can_manage']=!empty($input['admin']); $GLOBALS['nonce_ok']=!empty($input['nonce']);
    if (!empty($input['network'])) {
        $GLOBALS['multisite']=true; $GLOBALS['can_manage_network']=!empty($input['networkAdmin']);
        update_site_option('active_sitewide_plugins', array('boykov-leads/boykov-leads.php'=>time()));
    }
    try { $plugin->settings(); } catch (Throwable $e) { echo wp_json_encode(array('blocked'=>$e->getMessage(), 'options'=>$GLOBALS['options'])); }
} elseif ($mode === 'capture-failure') {
    $s = new Fixture_Submission(); $abort=false;
    $plugin->capture(new Fixture_Form(),$abort,$s);
    echo wp_json_encode(array('abort'=>$abort,'response'=>$s->response));
} elseif ($mode === 'configure-failure') {
    $GLOBALS['transport_response'] = array('response'=>array('code'=>401),'body'=>'{}');
    if (!empty($input['existing'])) { $GLOBALS['options'][Boykov_Leads_Plugin::CONFIG] = array('endpoint'=>$config['endpoint'],'token'=>str_repeat('b',64)); }
    $q = new class {
        public function check() {}
        public function stats() { return array('total'=>0,'pending'=>0,'rejected'=>0,'delivered'=>0,'oldest'=>null); }
    };
    $controller = new Boykov_Leads_Plugin($q);
    try { $controller->configure($config['endpoint'], str_repeat('a',64)); }
    catch (Throwable $e) { echo wp_json_encode(array('code'=>$e->getMessage(),'config'=>get_option(Boykov_Leads_Plugin::CONFIG, null))); }
} elseif ($mode === 'install') {
    $plugin->activate(); $plugin->activate(); echo wp_json_encode(array('stats'=>$queue->stats(), 'schedule'=>$GLOBALS['scheduled']));
} elseif ($mode === 'capture') {
    $queue->install(); $s=new Fixture_Submission(); $abort=false;
    $plugin->capture(new Fixture_Form(),$abort,$s); $plugin->capture(new Fixture_Form(),$abort,$s);
    echo wp_json_encode(array('abort'=>$abort, 'stats'=>$queue->stats(), 'row'=>$wpdb->get_row('SELECT * FROM wp_boykov_lead_outbox ORDER BY id DESC LIMIT 1',ARRAY_A)));
} elseif ($mode === 'run') {
    $now = isset($input['now']) ? $input['now'] : time();
    $worker = new Boykov_Leads_Delivery($queue, function ($url,$body,$token) use ($input) {
        if (substr($url,-10)==='/heartbeat') { return array('response'=>array('code'=>200),'body'=>wp_json_encode(array('ok'=>true,'siteId'=>isset($input['site'])?$input['site']:'fixture'))); }
        if (!empty($input['real'])) { return Boykov_Leads_Plugin::http($url,$body,$token); }
        if (!empty($input['sleep'])) { usleep((int)$input['sleep']*1000); }
        return isset($input['response']) ? $input['response'] : new WP_Error();
    }, function () use ($now) { return $now; });
    echo wp_json_encode(array('result'=>$worker->run($config, true),'rows'=>$wpdb->get_results('SELECT * FROM wp_boykov_lead_outbox ORDER BY id',ARRAY_A)));
} elseif ($mode === 'retry') {
    if (!$queue->acquire()) { throw new RuntimeException('BUSY'); }
    try { $queue->retry(); } finally { $queue->release(); }
    echo wp_json_encode($queue->stats());
} elseif ($mode === 'page') {
    // No customer records or saved key should appear in the administration HTML.
    $GLOBALS['can_manage']=true; $GLOBALS['options'][Boykov_Leads_Plugin::CONFIG]=$config;
    $plugin->page();
} elseif ($mode === 'lock-held') {
    $lock = 'boykov-leads-'.substr(hash('sha256', DB_NAME.':wp_boykov_lead_outbox'), 0, 40);
    echo wp_json_encode((bool) $wpdb->get_var($wpdb->prepare('SELECT IS_USED_LOCK(%s)', $lock)));
} elseif (strpos($mode, 'network-') === 0) {
    require __DIR__.'/wordpress-network.php';
} elseif ($mode === 'raw-sql') {
    foreach ($input['sql'] as $sql) { if ($wpdb->query($sql) === false) { throw new RuntimeException('FIXTURE_SQL_FAILED:'.$wpdb->last_error); } }
    echo 'true';
} elseif (strpos($mode, 'statistics-') === 0) {
    require __DIR__.'/wordpress-statistics.php';
} else { throw new RuntimeException('UNKNOWN_MODE'); }
