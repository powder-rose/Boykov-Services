<?php
/**
 * Plugin Name: Boykov Services — заявки
 * Description: Очередь доставки форм energo-365.ru и его поддоменов в Boykov Services.
 * Version: 1.1.0
 * Requires at least: 5.8
 * Requires PHP: 7.3
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__.'/includes/core.php';

final class Boykov_Leads_Plugin {
    const CONFIG = 'boykov_leads_connection_v1';
    const STATE = 'boykov_leads_delivery_v1';
    const HOOK = 'boykov_leads_delivery_tick';
    const COORDINATOR = 'boykov_leads_energo_coordinator_v1';
    const INITIALIZED = 'boykov_leads_queue_initialized_v1';
    private $queue;
    private $seen = array();

    public function __construct($queue = null) {
        $this->queue = $queue;
        add_filter('cron_schedules', array($this, 'schedules'));
        add_action(self::HOOK, array($this, 'scheduled_run'));
        add_action('wp_initialize_site', array($this, 'initialize_site'), 200, 1);
        if (!self::correct_host()) { return; }
        add_action('wpcf7_before_send_mail', array($this, 'capture'), PHP_INT_MAX, 3);
        add_action('admin_menu', array($this, 'menu'));
        add_action('admin_post_boykov_leads_settings', array($this, 'settings'));
        add_action('admin_post_boykov_leads_run', array($this, 'manual_run'));
        add_action('admin_notices', array($this, 'notice'));
    }

    public static function correct_host() {
        return Boykov_Leads_Payload::source_host(wp_parse_url(home_url('/'), PHP_URL_HOST));
    }

    private function queue() {
        global $wpdb;
        // switch_to_blog changes the table prefix without reloading plugin code.
        return $this->queue ?: new Boykov_Leads_Queue($wpdb);
    }

    public static function network_mode() {
        $plugins = is_multisite() ? get_site_option('active_sitewide_plugins', array()) : array();
        return isset($plugins[plugin_basename(__FILE__)]);
    }

    private function option($key, $default = array()) {
        return self::network_mode() ? get_site_option($key, $default) : get_option($key, $default);
    }

    private function set_option($key, $value) {
        if (self::network_mode()) { update_site_option($key, $value); }
        else { update_option($key, $value, false); }
    }

    public static function network_sites() {
        $matched = array();
        for ($offset = 0; ; $offset += 100) {
            $ids = get_sites(array('network_id' => get_current_network_id(), 'fields' => 'ids',
                'number' => 100, 'offset' => $offset, 'deleted' => 0, 'archived' => 0, 'spam' => 0));
            foreach ($ids as $id) {
                switch_to_blog((int) $id);
                try { if (self::correct_host()) { $matched[] = (int) $id; } }
                finally { restore_current_blog(); }
            }
            if (count($ids) < 100) { break; }
        }
        return $matched;
    }

    private function provision() {
        $queue = $this->queue();
        if (get_option(self::INITIALIZED, false)) { $queue->check(); }
        else {
            $queue->install();
            update_option(self::INITIALIZED, true, false);
        }
    }

    public function initialize_site($site) {
        if (!self::network_mode()) { return; }
        switch_to_blog((int) $site->blog_id);
        try { if (self::correct_host()) { $this->provision(); } }
        catch (Throwable $error) { error_log('Boykov Services: new subsite queue requires administrator attention.'); }
        finally { restore_current_blog(); }
    }

    public static function cf7_ready() {
        return defined('WPCF7_VERSION') && version_compare(WPCF7_VERSION, '5.4', '>=')
            && class_exists('WPCF7_Submission');
    }

    public function schedules($schedules) {
        $schedules['boykov_leads_minute'] = array('interval' => 60, 'display' => 'Boykov Services: каждую минуту');
        return $schedules;
    }

    public function activate($network_wide = false) {
        if (PHP_VERSION_ID < 70300) { wp_die('Нужен PHP 7.3 или новее.'); }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        try {
            if ($network_wide && is_multisite()) {
                $ids = self::network_sites();
                if (!$ids) { wp_die('В этой сети не найдены energo-365.ru или его поддомены.'); }
                $coordinator = $ids[0]; $root_found = false;
                foreach ($ids as $id) {
                    switch_to_blog($id);
                    try {
                        $this->provision();
                        wp_clear_scheduled_hook(self::HOOK);
                        if (!$root_found && strtolower((string) wp_parse_url(home_url('/'), PHP_URL_HOST)) === 'energo-365.ru') {
                            $coordinator = $id; $root_found = true;
                        }
                    } finally { restore_current_blog(); }
                }
                update_site_option(self::COORDINATOR, $coordinator);
                switch_to_blog($coordinator);
                try { $this->schedule(); } finally { restore_current_blog(); }
            } else {
                if (!self::correct_host()) { wp_die('Активируйте плагин на energo-365.ru, его поддомене или для всей сети.'); }
                $this->provision();
                $this->schedule();
            }
        }
        catch (Throwable $error) { wp_die('Не удалось создать очередь заявок. Проверьте доступ к базе и поддержку InnoDB.'); }
        finally { $wpdb->suppress_errors($old); }
    }

    private function schedule() {
        if (!wp_next_scheduled(self::HOOK)) {
            $scheduled = wp_schedule_event(time() + 30, 'boykov_leads_minute', self::HOOK, array(), true);
            if (is_wp_error($scheduled) || !$scheduled) { wp_die('Очередь создана, но планировщик не настроен. Проверьте WP-Cron.'); }
        }
    }

    public function deactivate($network_wide = false) {
        if ($network_wide && is_multisite()) {
            foreach (self::network_sites() as $id) {
                switch_to_blog($id);
                try { wp_clear_scheduled_hook(self::HOOK); } finally { restore_current_blog(); }
            }
        } elseif (self::correct_host()) { wp_clear_scheduled_hook(self::HOOK); }
        // Configuration and all snapshots survive deactivation, deletion and reinstall.
    }

    public function capture($form, &$abort, $submission) {
        if ($abort || !self::correct_host()) { return; }
        $identity = is_object($submission) ? spl_object_hash($submission) : '';
        if ($identity !== '' && isset($this->seen[$identity])) { return; }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        try {
            if (!self::cf7_ready() || !is_object($submission)) { throw new RuntimeException('CAPTURE_CONTEXT'); }
            $this->provision();
            $now = time();
            $payload = Boykov_Leads_Payload::make($form, $submission, 'cf7:'.wp_generate_uuid4(), $now);
            $this->queue()->enqueue($payload, $now);
            $this->seen[$identity] = true;
        } catch (Throwable $error) {
            $abort = true;
            if (is_object($submission) && method_exists($submission, 'set_response')) {
                $submission->set_response('Не удалось сохранить заявку. Попробуйте ещё раз или позвоните нам.');
            }
            // Do not expose SQL, tokens or customer input in public replies/logs.
            error_log('Boykov Services: lead was not saved; form submission aborted.');
        } finally { $wpdb->suppress_errors($old); }
    }

    public static function http($url, $body, $token) {
        return wp_safe_remote_post($url, array('timeout' => 6, 'redirection' => 0, 'sslverify' => true,
            'limit_response_size' => 16384, 'headers' => array('Content-Type' => 'application/json; charset=utf-8',
                'Authorization' => 'Bearer '.$token), 'body' => $body, 'data_format' => 'body'));
    }

    public function run() {
        $config = $this->option(self::CONFIG);
        if (!isset($config['endpoint'], $config['token'])) { throw new RuntimeException('NOT_CONFIGURED'); }
        if (!self::correct_host()) { throw new RuntimeException('WRONG_SITE'); }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        try {
            if (self::network_mode()) { $result = $this->run_network($config); }
            else {
                $worker = new Boykov_Leads_Delivery($this->queue(), array(__CLASS__, 'http'));
                $result = $worker->run($config, self::cf7_ready());
            }
            if (empty($result['busy'])) {
                $previous = $this->option(self::STATE);
                $this->set_option(self::STATE, array('last_run' => time(),
                    'last_heartbeat' => $result['heartbeat_ok'] ? time() : (isset($previous['last_heartbeat']) ? $previous['last_heartbeat'] : 0),
                    'cursor' => isset($result['next_cursor']) ? $result['next_cursor'] : 0,
                    'error' => !$result['heartbeat_ok'] ? 'HEARTBEAT_UNCONFIRMED' : (!empty($result['scan_failed']) ? 'SUBSITE_QUEUE_FAILED' : '')));
            }
            return $result;
        } catch (Throwable $error) {
            $this->record_error($error);
            throw $error;
        } finally { $wpdb->suppress_errors($old); }
    }

    private function run_network($config) {
        global $wpdb;
        $lock = new Boykov_Leads_Queue($wpdb, 'energo-network-'.get_current_network_id());
        if (!$lock->acquire()) { return array('busy' => true); }
        try {
            $ids = self::network_sites();
            if (!$ids) { throw new RuntimeException('NO_SUBSITES'); }
            $state = $this->option(self::STATE);
            $cursor = isset($state['cursor']) ? (int) $state['cursor'] % count($ids) : 0;
            $ordered = array_merge(array_slice($ids, $cursor), array_slice($ids, 0, $cursor));
            $deadline = time() + 18;
            $stats = array('total'=>0,'pending'=>0,'rejected'=>0,'delivered'=>0,'oldest'=>null);
            $scan_ok = true;
            foreach ($ordered as $id) {
                if (!$lock->owns_lock()) { throw new RuntimeException('QUEUE_LOCK_LOST'); }
                switch_to_blog($id);
                try {
                    $this->provision();
                    $queue = $this->queue();
                    if (time() < $deadline) {
                        $worker = new Boykov_Leads_Delivery($queue, array(__CLASS__, 'http'));
                        $worker->run($config, true, false, $deadline);
                    }
                    $row = $queue->stats();
                    foreach (array('total','pending','rejected','delivered') as $key) { $stats[$key] += $row[$key]; }
                    if ($row['oldest'] && (!$stats['oldest'] || $row['oldest'] < $stats['oldest'])) { $stats['oldest'] = $row['oldest']; }
                } catch (Throwable $error) { $scan_ok = false; }
                finally { restore_current_blog(); }
            }
            if (!$lock->owns_lock()) { throw new RuntimeException('QUEUE_LOCK_LOST'); }
            $endpoint = Boykov_Leads_Payload::endpoint($config['endpoint']);
            $response = self::http($endpoint['url'].'/heartbeat', wp_json_encode(array('pending'=>$stats['pending'],
                'rejected'=>$stats['rejected'],'scanOk'=>$scan_ok,'oldestPendingAt'=>$stats['oldest'])), $config['token']);
            return array('busy'=>false, 'stats'=>$stats, 'sites'=>count($ids), 'scan_failed'=>!$scan_ok,
                'heartbeat_ok'=>Boykov_Leads_Payload::acknowledgement($response, $endpoint['site_id']),
                'next_cursor'=>($cursor + 1) % count($ids));
        } finally { $lock->release(); }
    }

    private function record_error($error) {
        $state = $this->option(self::STATE);
        $code = preg_match('/^[A-Z_]{3,64}$/D', $error->getMessage()) ? $error->getMessage() : 'DELIVERY_FAILED';
        $state['last_run'] = time();
        $state['error'] = $code;
        $this->set_option(self::STATE, $state);
    }

    private function summary() {
        $stats = array('total'=>0,'pending'=>0,'rejected'=>0,'delivered'=>0,'oldest'=>null,'scan_ok'=>true,'hosts'=>array());
        $ids = self::network_mode() ? self::network_sites() : array(get_current_blog_id());
        foreach ($ids as $id) {
            if (self::network_mode()) { switch_to_blog($id); }
            try {
                $stats['hosts'][] = wp_parse_url(home_url('/'), PHP_URL_HOST);
                $queue = $this->queue(); $queue->check(); $row = $queue->stats();
                foreach (array('total','pending','rejected','delivered') as $key) { $stats[$key] += $row[$key]; }
                if ($row['oldest'] && (!$stats['oldest'] || $row['oldest'] < $stats['oldest'])) { $stats['oldest'] = $row['oldest']; }
            } catch (Throwable $error) { $stats['scan_ok'] = false; }
            finally { if (self::network_mode()) { restore_current_blog(); } }
        }
        if (!$ids) { $stats['scan_ok'] = false; }
        return $stats;
    }

    private function capability() {
        return self::network_mode() ? 'manage_network_options' : 'manage_options';
    }

    public function scheduled_run() {
        if (!self::correct_host() || (self::network_mode() && get_current_blog_id() !== (int) get_site_option(self::COORDINATOR, 0))) { return; }
        try { $this->run(); }
        catch (Throwable $error) { /* State is visible to administrators; queue remains intact. */ }
    }

    public function menu() {
        if (!self::correct_host()) { return; }
        add_options_page('Boykov Services — заявки', 'Boykov Services', $this->capability(), 'boykov-leads', array($this, 'page'));
    }

    private function guard() {
        if (!self::correct_host() || !current_user_can($this->capability())) { wp_die('Недостаточно прав.', '', array('response' => 403)); }
        check_admin_referer('boykov_leads_admin');
    }

    private function redirect($code) {
        wp_safe_redirect(add_query_arg(array('page' => 'boykov-leads', 'result' => $code), admin_url('options-general.php')));
        exit;
    }

    public function settings() {
        $this->guard();
        try {
            $result = $this->configure(
                isset($_POST['endpoint']) && is_string($_POST['endpoint']) ? wp_unslash($_POST['endpoint']) : '',
                isset($_POST['token']) && is_string($_POST['token']) ? trim(wp_unslash($_POST['token'])) : '');
            $this->redirect(!empty($result['heartbeat_ok']) ? 'connected' : 'saved');
        } catch (Throwable $error) {
            $this->record_error($error);
            $this->redirect('failed');
        }
    }

    public function configure($url, $token) {
        if (!self::correct_host()) { throw new RuntimeException('WRONG_SITE'); }
        $endpoint = Boykov_Leads_Payload::endpoint($url);
        $previous = $this->option(self::CONFIG);
        if (!empty($previous['endpoint']) && $previous['endpoint'] !== $endpoint['url']) { throw new RuntimeException('ENDPOINT_LOCKED'); }
        if ($token === '' && isset($previous['token'])) { $token = $previous['token']; }
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) { throw new RuntimeException('INVALID_KEY'); }
        $stats = $this->summary();
        $report = wp_json_encode(array('pending' => $stats['pending'], 'rejected' => $stats['rejected'],
            'scanOk' => $stats['scan_ok'], 'oldestPendingAt' => $stats['oldest']));
        // A typo or wrong key must not bind an unconfigured queue or replace a working key.
        $response = self::http($endpoint['url'].'/heartbeat', $report, $token);
        if (!Boykov_Leads_Payload::acknowledgement($response, $endpoint['site_id'])) { throw new RuntimeException('HUB_CONNECTION_UNCONFIRMED'); }
        $this->set_option(self::CONFIG, array('endpoint' => $endpoint['url'], 'token' => $token));
        return $this->run();
    }

    public function manual_run() {
        $this->guard();
        try {
            // A retry never changes snapshot bytes, event IDs or delivered rows.
            if (isset($_POST['retry']) && $_POST['retry'] === '1') {
                $ids = self::network_mode() ? self::network_sites() : array(get_current_blog_id());
                foreach ($ids as $id) {
                    if (self::network_mode()) { switch_to_blog($id); }
                    try {
                        $queue = $this->queue();
                        if (!$queue->acquire()) { throw new RuntimeException('QUEUE_BUSY'); }
                        try { $queue->retry(); } finally { $queue->release(); }
                    } finally { if (self::network_mode()) { restore_current_blog(); } }
                }
            }
            $result = $this->run();
            $this->redirect(!empty($result['busy']) ? 'busy' : (!empty($result['heartbeat_ok']) ? 'connected' : 'saved'));
        } catch (Throwable $error) { $this->record_error($error); $this->redirect('failed'); }
    }

    public function notice() {
        if (!self::correct_host() || !current_user_can($this->capability())) { return; }
        $config = $this->option(self::CONFIG);
        $state = $this->option(self::STATE);
        $problem = empty($config['token']) || (!self::network_mode() && !self::cf7_ready())
            || empty($state['last_heartbeat']) || time() - (int) $state['last_heartbeat'] > 120 || !empty($state['error']);
        if ($problem) {
            echo '<div class="notice notice-warning"><p>Boykov Services: проверьте подключение и расписание доставки заявок. <a href="'.esc_url(admin_url('options-general.php?page=boykov-leads')).'">Открыть настройки</a></p></div>';
        }
    }

    public function page() {
        if (!self::correct_host() || !current_user_can($this->capability())) { wp_die('Недостаточно прав.'); }
        $config = $this->option(self::CONFIG);
        $state = $this->option(self::STATE);
        $stats = $this->summary();
        $messages = array('connected' => 'Центр подтвердил отчёт доставки. Проверьте контрольную заявку из каждой формы.',
            'saved' => 'Настройки сохранены. Подтверждения от центра пока нет: проверьте ключ и расписание.',
            'failed' => 'Операция не выполнена. Проверьте адрес, ключ и состояние очереди.', 'busy' => 'Отправитель уже работает. Повторите проверку через минуту.');
        echo '<div class="wrap"><h1>Boykov Services — заявки</h1><p>energo-365.ru и поддомены · Contact Form 7</p>';
        if (self::network_mode()) { echo '<p>Общее подключение сети. Очереди и отчёт объединяют: '.esc_html(implode(', ', $stats['hosts'])).'.</p>'; }
        $result = isset($_GET['result']) && is_string($_GET['result']) ? $_GET['result'] : '';
        if (isset($messages[$result])) { echo '<div class="notice notice-info inline"><p>'.esc_html($messages[$result]).'</p></div>'; }
        if (!self::network_mode() && !self::cf7_ready()) { echo '<div class="notice notice-error inline"><p>Contact Form 7 не активен или не поддерживается.</p></div>'; }
        if (!$stats['scan_ok']) { echo '<div class="notice notice-error inline"><p>Не удалось прочитать одну или несколько очередей. Проверьте базу и резервные копии.</p></div>'; }
        echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'">';
        wp_nonce_field('boykov_leads_admin');
        echo '<input type="hidden" name="action" value="boykov_leads_settings"><table class="form-table"><tr><th><label for="boykov-endpoint">Адрес подключения</label></th><td>';
        echo '<input class="large-text" id="boykov-endpoint" name="endpoint" type="url" required value="'.esc_attr(isset($config['endpoint']) ? $config['endpoint'] : '').'" placeholder="https://boykov-services.ru/hooks/leads/…">';
        echo '<p class="description">В Boykov Services добавьте energo-365.ru со способом «Серверный агент» и скопируйте полный URL.</p></td></tr>';
        echo '<tr><th><label for="boykov-token">Ключ подключения</label></th><td><input class="regular-text" id="boykov-token" name="token" type="password" autocomplete="new-password" value="">';
        echo '<p class="description">64 символа, без Bearer. '.(!empty($config['token']) ? 'Ключ сохранён. Пустое поле сохраняет действующий ключ.' : 'Вставьте новый ключ для этого сайта.').'</p></td></tr></table>';
        submit_button('Сохранить и проверить');
        echo '</form><hr><h2>Доставка</h2><table class="widefat striped"><tbody>';
        if ($stats) {
            foreach (array('Всего сохранено' => 'total', 'Ожидают отправки' => 'pending', 'Требуют разбора' => 'rejected', 'Доставлено' => 'delivered') as $label => $key) {
                echo '<tr><th>'.esc_html($label).'</th><td>'.esc_html((string) $stats[$key]).'</td></tr>';
            }
        }
        foreach (array('Последний запуск' => 'last_run', 'Подтверждённый отчёт' => 'last_heartbeat') as $label => $key) {
            $date = empty($state[$key]) ? 'Ещё не было' : gmdate('d.m.Y H:i:s', $state[$key] + 10800).' МСК';
            echo '<tr><th>'.esc_html($label).'</th><td>'.esc_html($date).'</td></tr>';
        }
        echo '<tr><th>Код ошибки</th><td>'.esc_html(!empty($state['error']) ? $state['error'] : '—').'</td></tr></tbody></table>';
        if (isset($state['error']) && $state['error'] === 'HUB_CONNECTION_UNCONFIRMED') {
            echo '<p>Центр не подтвердил адрес и ключ. Проверьте, что они скопированы из подключения energo-365.ru со способом «Серверный агент». Прежние настройки сохранены.</p>';
        }
        echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'">';
        wp_nonce_field('boykov_leads_admin');
        echo '<input type="hidden" name="action" value="boykov_leads_run">';
        submit_button('Отправить очередь и проверить', 'secondary', 'submit', false);
        echo ' <label><input name="retry" type="checkbox" value="1"> Повторить также отклонённые записи</label></form>';
        echo '<h2>Расписание</h2><p>Добавьте в планировщик хостинга запуск <strong>каждую минуту</strong>: все пять полей расписания — <code>*</code>.</p>';
        $cron_url = self::network_mode() ? get_site_url((int) get_site_option(self::COORDINATOR, get_current_blog_id()), 'wp-cron.php') : site_url('wp-cron.php');
        echo '<p><code>'.esc_html("wget -q -O /dev/null --timeout=30 '".$cron_url."?doing_wp_cron'").'</code></p>';
        echo '<p>После настройки оставьте страницу на 2–3 минуты, обновите её и проверьте время отчёта. Без посещений сайта отчёты должны продолжать обновляться.</p>';
        echo '<p>Проверка связи не заменяет контрольную отправку из каждой формы. Копии остаются в базе сайта после доставки; деактивация и удаление плагина их не стирают.</p></div>';
    }
}

global $wpdb;
$GLOBALS['boykov_leads_plugin'] = new Boykov_Leads_Plugin();
register_activation_hook(__FILE__, array($GLOBALS['boykov_leads_plugin'], 'activate'));
register_deactivation_hook(__FILE__, array($GLOBALS['boykov_leads_plugin'], 'deactivate'));
