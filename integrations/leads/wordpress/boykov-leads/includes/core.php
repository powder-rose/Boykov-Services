<?php
// Shared by the WordPress plugin and its protocol tests. PHP 7.3+.
if (!defined('ABSPATH')) { exit; }

final class Boykov_Leads_Payload {
    public static function source_host($host) {
        return is_string($host) && (bool) preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*energo-365\.ru$/Di', $host);
    }
    public static function endpoint($url) {
        if (!is_string($url) || !preg_match('~^https://boykov-services\.ru/hooks/leads/([a-z0-9][a-z0-9-]{0,63})$~D', trim($url), $match)) {
            throw new RuntimeException('Укажите полный адрес серверного подключения из Boykov Services.');
        }
        return array('url' => trim($url), 'site_id' => $match[1]);
    }

    public static function text($value) {
        if (is_array($value)) {
            $value = wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($value === false) { throw new RuntimeException('INVALID_FIELD'); }
        }
        if (!is_scalar($value) && $value !== null) { throw new RuntimeException('INVALID_FIELD'); }
        return trim(str_replace("\0", '', (string) $value));
    }

    public static function make($form, $submission, $event_id, $timestamp) {
        $labels = array('text-903' => 'Имя', 'mask-101' => 'Телефон',
            'email-466' => 'Электронная почта', 'checkbox-659' => 'Согласие на обработку персональных данных');
        $posted = $submission->get_posted_data();
        if (!is_array($posted)) { throw new RuntimeException('NO_FIELDS'); }
        $fields = array();
        $values = array();
        foreach ($posted as $key => $value) {
            // CF7 internals, CAPTCHA responses and credentials are not lead fields.
            if (!is_string($key) || $key === '' || $key[0] === '_'
                || preg_match('/captcha|password|passwd|secret|token|api[_-]?key|authorization/i', $key)) { continue; }
            $value = self::text($value);
            $values[$key] = $value;
            $fields[] = array('label' => isset($labels[$key]) ? $labels[$key] : $key, 'value' => $value);
        }
        $name = isset($values['text-903']) ? $values['text-903'] : '';
        $phone = isset($values['mask-101']) ? $values['mask-101'] : '';
        $email = isset($values['email-466']) ? $values['email-466'] : '';
        $message = '';
        foreach ($form->scan_form_tags() as $tag) {
            if (!isset($values[$tag->name])) { continue; }
            $type = isset($tag->basetype) ? $tag->basetype : '';
            if ($name === '' && preg_match('/^(your-)?name$|имя|фио/ui', $tag->name)) { $name = $values[$tag->name]; }
            if ($phone === '' && in_array($type, array('tel', 'mask'), true)) { $phone = $values[$tag->name]; }
            if ($email === '' && $type === 'email') { $email = $values[$tag->name]; }
            if ($message === '' && $type === 'textarea') { $message = $values[$tag->name]; }
        }
        $title = self::text($form->title());
        $source = (string) $submission->get_meta('url');
        $url = wp_parse_url($source);
        $home = wp_parse_url(home_url('/'));
        $home_host = isset($home['host']) && self::source_host($home['host']) ? strtolower($home['host']) : 'energo-365.ru';
        $page_url = 'https://'.$home_host.(isset($home['path']) ? $home['path'] : '/');
        if (is_array($url) && isset($url['host']) && self::source_host($url['host'])
            && isset($url['scheme']) && in_array(strtolower($url['scheme']), array('http', 'https'), true)
            && !isset($url['user']) && !isset($url['pass'])) {
            // The page path is useful; arbitrary query credentials are not.
            $page_url = 'https://'.strtolower($url['host']).(isset($url['path']) ? $url['path'] : '/');
        }
        $fields[] = array('label' => 'Сайт', 'value' => wp_parse_url($page_url, PHP_URL_HOST));
        $fields[] = array('label' => 'Номер формы Contact Form 7', 'value' => (string) $form->id());
        return array('eventId' => $event_id, 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $timestamp),
            'name' => $name, 'phone' => $phone, 'email' => $email, 'service' => $title,
            'message' => $message, 'pageUrl' => $page_url, 'form' => $title, 'fields' => $fields);
    }

    public static function acknowledgement($response, $site_id, $event_id = null) {
        if (is_wp_error($response)) { return false; }
        $code = wp_remote_retrieve_response_code($response);
        if (!in_array($code, array(200, 201), true)) { return false; }
        $body = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($body) || !isset($body['ok'], $body['siteId'])
            || $body['ok'] !== true || $body['siteId'] !== $site_id) { return false; }
        return $event_id === null || (isset($body['eventId'], $body['id']) && $body['eventId'] === $event_id
            && is_string($body['id']) && preg_match('/^[a-f0-9-]{36}$/D', $body['id']));
    }
}

final class Boykov_Leads_Queue {
    private $db;
    private $table;
    private $lock;

    public function __construct($db, $lock_scope = null) {
        $this->db = $db;
        $this->table = $db->prefix.'boykov_lead_outbox';
        if (!preg_match('/^[A-Za-z0-9_]+$/D', $this->table)) { throw new RuntimeException('TABLE_NAME'); }
        $this->lock = 'boykov-leads-'.substr(hash('sha256', DB_NAME.':'.($lock_scope ?: $this->table)), 0, 40);
    }

    public function install() {
        $charset = $this->db->get_charset_collate();
        $sql = "CREATE TABLE IF NOT EXISTS `{$this->table}` (
            id bigint unsigned NOT NULL AUTO_INCREMENT,
            event_id varchar(64) NOT NULL,
            payload longtext NOT NULL,
            created_at datetime NOT NULL,
            status varchar(16) NOT NULL DEFAULT 'pending',
            attempts int unsigned NOT NULL DEFAULT 0,
            next_attempt_at datetime NOT NULL,
            delivered_at datetime NULL,
            hub_id varchar(64) NOT NULL DEFAULT '',
            last_error varchar(64) NOT NULL DEFAULT '',
            PRIMARY KEY (id), UNIQUE KEY event_id (event_id),
            KEY delivery (status,next_attempt_at,id)
        ) ENGINE=InnoDB $charset";
        if ($this->db->query($sql) === false) { throw new RuntimeException('QUEUE_CREATE_FAILED'); }
        $this->check();
    }

    public function check() {
        $engine = $this->db->get_var($this->db->prepare(
            'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $this->table));
        if (strtolower((string) $engine) !== 'innodb') { throw new RuntimeException('QUEUE_NOT_INNODB'); }
        // Also detects a partially restored or unrelated table with this name.
        $this->db->last_error = '';
        $this->db->get_results("SELECT id,event_id,payload,created_at,status,attempts,next_attempt_at,delivered_at,hub_id,last_error FROM `{$this->table}` LIMIT 0");
        if ($this->db->last_error) { throw new RuntimeException('QUEUE_SCHEMA'); }
    }

    public function enqueue($payload, $timestamp) {
        $json = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) { throw new RuntimeException('QUEUE_ENCODING'); }
        $date = gmdate('Y-m-d H:i:s', $timestamp);
        $saved = $this->db->insert($this->table, array('event_id' => $payload['eventId'], 'payload' => $json,
            'created_at' => $date, 'next_attempt_at' => $date), array('%s','%s','%s','%s'));
        if ($saved !== 1) { throw new RuntimeException('QUEUE_SAVE_FAILED'); }
        return (int) $this->db->insert_id;
    }

    public function stats() {
        $row = $this->db->get_row("SELECT COUNT(*) total,
            COALESCE(SUM(status='pending'),0) pending, COALESCE(SUM(status='rejected'),0) rejected,
            COALESCE(SUM(status='delivered'),0) delivered,
            MIN(CASE WHEN status='pending' THEN created_at END) oldest
            FROM `{$this->table}`", ARRAY_A);
        if (!is_array($row) || $this->db->last_error) { throw new RuntimeException('QUEUE_READ_FAILED'); }
        return array('total' => (int) $row['total'], 'pending' => (int) $row['pending'],
            'rejected' => (int) $row['rejected'], 'delivered' => (int) $row['delivered'],
            'oldest' => $row['oldest'] ? str_replace(' ', 'T', $row['oldest']).'Z' : null);
    }

    public function acquire() {
        $value = $this->db->get_var($this->db->prepare('SELECT GET_LOCK(%s,0)', $this->lock));
        if ($value === null || $this->db->last_error) { throw new RuntimeException('QUEUE_LOCK_FAILED'); }
        return (string) $value === '1';
    }

    public function owns_lock() {
        return (string) $this->db->get_var($this->db->prepare(
            'SELECT IS_USED_LOCK(%s)=CONNECTION_ID()', $this->lock)) === '1';
    }

    public function release() {
        $this->db->get_var($this->db->prepare('SELECT RELEASE_LOCK(%s)', $this->lock));
    }

    public function due($timestamp) {
        $rows = $this->db->get_results($this->db->prepare("SELECT * FROM `{$this->table}`
            WHERE status='pending' AND next_attempt_at<=%s ORDER BY id LIMIT 20", gmdate('Y-m-d H:i:s', $timestamp)), ARRAY_A);
        if (!is_array($rows) || $this->db->last_error) { throw new RuntimeException('QUEUE_READ_FAILED'); }
        return $rows;
    }

    public function result($row, $status, $error, $hub_id, $timestamp) {
        $attempts = (int) $row['attempts'] + 1;
        $delay = min(900, 30 * pow(2, min(5, $attempts - 1)));
        $saved = $this->db->query($this->db->prepare("UPDATE `{$this->table}` SET status=%s,
            attempts=%d,last_error=%s,hub_id=%s,next_attempt_at=%s,delivered_at=".
            ($status === 'delivered' ? '%s' : 'NULL')." WHERE id=%d AND status='pending' AND attempts=%d",
            array_merge(array($status, $attempts, $error, $hub_id, gmdate('Y-m-d H:i:s', $timestamp + $delay)),
                $status === 'delivered' ? array(gmdate('Y-m-d H:i:s', $timestamp)) : array(),
                array((int) $row['id'], (int) $row['attempts']))));
        if ($saved !== 1) { throw new RuntimeException('QUEUE_UPDATE_FAILED'); }
    }

    public function retry() {
        if ($this->db->query("UPDATE `{$this->table}` SET status='pending',next_attempt_at=UTC_TIMESTAMP(),last_error=''
            WHERE status IN ('pending','rejected')") === false) { throw new RuntimeException('QUEUE_UPDATE_FAILED'); }
    }
}

final class Boykov_Leads_Delivery {
    private $queue;
    private $send;
    private $clock;

    public function __construct($queue, $send, $clock = null) {
        $this->queue = $queue;
        $this->send = $send;
        $this->clock = $clock ?: function () { return time(); };
    }

    public function run($config, $scan_ok, $report_heartbeat = true, $deadline = null) {
        $endpoint = Boykov_Leads_Payload::endpoint($config['endpoint']);
        if (!preg_match('/^[a-f0-9]{64}$/D', $config['token'])) { throw new RuntimeException('INVALID_KEY'); }
        $this->queue->check();
        if (!$this->queue->acquire()) { return array('busy' => true); }
        try {
            $started = call_user_func($this->clock);
            $stop_at = $deadline === null ? $started + 18 : $deadline;
            $rows = $this->queue->due($started);
            foreach ($rows as $row) {
                if (call_user_func($this->clock) >= $stop_at) { break; }
                if (!$this->queue->owns_lock()) { throw new RuntimeException('QUEUE_LOCK_LOST'); }
                // Bytes are read from the durable snapshot, never remapped on retry.
                $response = call_user_func($this->send, $endpoint['url'], $row['payload'], $config['token']);
                if (!$this->queue->owns_lock()) { throw new RuntimeException('QUEUE_LOCK_LOST'); }
                $code = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
                $ok = Boykov_Leads_Payload::acknowledgement($response, $endpoint['site_id'], $row['event_id']);
                $body = $ok ? json_decode(wp_remote_retrieve_body($response), true) : array();
                $reject = in_array($code, array(400, 409, 413, 422), true);
                $this->queue->result($row, $ok ? 'delivered' : ($reject ? 'rejected' : 'pending'),
                    $ok ? '' : ($code ? 'HTTP_'.$code.'_UNCONFIRMED' : 'TRANSPORT_UNCONFIRMED'),
                    $ok ? $body['id'] : '', call_user_func($this->clock));
                // Credentials/outage affect the whole batch. Preserve remaining rows.
                if (!$ok && (!$code || $code >= 500 || in_array($code, array(401,403,429), true))) { break; }
            }
            $stats = $this->queue->stats();
            if (!$report_heartbeat) { return array('busy' => false, 'stats' => $stats); }
            $json = wp_json_encode(array('pending' => $stats['pending'], 'rejected' => $stats['rejected'],
                'scanOk' => (bool) $scan_ok, 'oldestPendingAt' => $stats['oldest']));
            if (!$this->queue->owns_lock()) { throw new RuntimeException('QUEUE_LOCK_LOST'); }
            $response = call_user_func($this->send, $endpoint['url'].'/heartbeat', $json, $config['token']);
            return array('busy' => false, 'heartbeat_ok' => Boykov_Leads_Payload::acknowledgement($response, $endpoint['site_id']),
                'stats' => $stats);
        } finally {
            $this->queue->release();
        }
    }
}
