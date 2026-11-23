<?php
if (!defined("ABSPATH")) {
    exit();
}
require_once __DIR__ . "/statistics-core.php";
final class Boykov_Statistics_Plugin
{
    const VERSION = "boykov_statistics_schema_v1";
    const STATE = "boykov_statistics_delivery_v1";
    const SNAPSHOT = "boykov_statistics_snapshot_v1";
    const HOOK = "boykov_statistics_delivery_tick";
    private $file;
    public function __construct($file)
    {
        $this->file = $file;
        add_action("init", [$this, "setup"]);
        add_action("wp_enqueue_scripts", [$this, "enqueue"]);
        add_action("wp_ajax_nopriv_boykov_statistics_view", [$this, "receive"]);
        add_action("wp_ajax_boykov_statistics_view", [$this, "receive"]);
        add_action(self::HOOK, [$this, "scheduled_run"]);
        add_action("admin_post_boykov_statistics_run", [$this, "manual_run"]);
        add_filter("autoptimize_filter_js_exclude", [
            $this,
            "exclude_optimizer",
        ]);
    }
    public function option($key, $default = [])
    {
        return Boykov_Leads_Plugin::network_mode()
            ? get_site_option($key, $default)
            : get_option($key, $default);
    }
    private function save($key, $value)
    {
        if (Boykov_Leads_Plugin::network_mode()) {
            update_site_option($key, $value);
        } else {
            update_option($key, $value, false);
        }
        if ($this->option($key) !== $value) {
            throw new RuntimeException("STATISTICS_STATE_WRITE");
        }
    }
    private function network()
    {
        return is_multisite() ? (int) get_current_network_id() : 0;
    }
    private function ledger()
    {
        global $wpdb;
        return new Boykov_Statistics_Ledger($wpdb);
    }
    private function coordinator()
    {
        return Boykov_Leads_Plugin::network_mode()
            ? (int) get_site_option(Boykov_Leads_Plugin::COORDINATOR, 0)
            : get_current_blog_id();
    }
    private function error($e)
    {
        $s = $this->option(self::STATE);
        $s["error"] = preg_match('/^[A-Z_0-9]{3,80}$/D', $e->getMessage())
            ? $e->getMessage()
            : "STATISTICS_FAILED";
        $s["last_run"] = time();
        try {
            $this->save(self::STATE, $s);
        } catch (Throwable $ignored) {
        }
    }
    public function setup()
    {
        if (!Boykov_Leads_Plugin::correct_host()) {
            return;
        }
        if (is_multisite() && !Boykov_Leads_Plugin::network_mode()) {
            $this->error(
                new RuntimeException("STATISTICS_ACTIVATE_FOR_NETWORK"),
            );
            return;
        }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        try {
            if (!$this->option(self::VERSION, 0)) {
                $lock = new Boykov_Leads_Queue(
                    $wpdb,
                    "statistics-install:" . $this->network(),
                );
                if (!$lock->acquire()) {
                    return;
                }
                try {
                    if (!$this->option(self::VERSION, 0)) {
                        $this->ledger()->install();
                        $this->save(self::VERSION, time());
                    }
                } finally {
                    $lock->release();
                }
            }
            if (
                get_current_blog_id() === $this->coordinator() &&
                !wp_next_scheduled(self::HOOK)
            ) {
                $ok = wp_schedule_event(
                    time() + 45,
                    "boykov_leads_minute",
                    self::HOOK,
                    [],
                    true,
                );
                if (!$ok || is_wp_error($ok)) {
                    throw new RuntimeException("STATISTICS_CRON");
                }
            }
        } catch (Throwable $e) {
            $this->error($e);
        } finally {
            $wpdb->suppress_errors($old);
        }
    }
    public function exclude_optimizer($list)
    {
        return $list . ",boykov-statistics.js";
    }
    public function enqueue()
    {
        if (
            !Boykov_Leads_Plugin::correct_host() ||
            !$this->option(self::VERSION, 0) ||
            is_admin() ||
            is_user_logged_in() ||
            is_404() ||
            is_preview() ||
            is_feed() ||
            is_trackback()
        ) {
            return;
        }
        try {
            $home = wp_parse_url(home_url("/"));
            $host = strtolower($home["host"]);
            $path = Boykov_Statistics_Core::path(
                isset($_SERVER["REQUEST_URI"]) ? $_SERVER["REQUEST_URI"] : "/",
            );
            $article = is_singular("post");
            $page = [
                "blog" => get_current_blog_id(),
                "host" => $host,
                "path" => $path,
                "article" => $article,
                "title" => $article
                    ? Boykov_Statistics_Core::text(
                        get_the_title(get_queried_object_id()),
                    )
                    : "",
            ];
            $config = [
                "endpoint" => admin_url("admin-ajax.php"),
                "pageToken" => Boykov_Statistics_Core::sign(
                    $page,
                    wp_salt("auth"),
                ),
            ];
            wp_enqueue_script(
                "boykov-statistics",
                plugins_url("assets/boykov-statistics.js", $this->file),
                [],
                "1.2.0",
                true,
            );
            wp_add_inline_script(
                "boykov-statistics",
                "window.BoykovStatistics=" .
                    wp_json_encode(
                        $config,
                        JSON_HEX_TAG |
                            JSON_HEX_AMP |
                            JSON_HEX_APOS |
                            JSON_HEX_QUOT,
                    ) .
                    ";",
                "before",
            );
        } catch (Throwable $e) {
            $this->error($e);
        }
    }
    public function receive()
    {
        nocache_headers();
        if (!Boykov_Leads_Plugin::correct_host()) {
            wp_send_json(["ok" => false], 404);
        }
        if (
            is_user_logged_in() ||
            ($_SERVER["HTTP_DNT"] ?? "") === "1" ||
            ($_SERVER["HTTP_SEC_GPC"] ?? "") === "1"
        ) {
            wp_send_json(["ok" => true, "ignored" => true]);
        }
        $ua = $_SERVER["HTTP_USER_AGENT"] ?? "";
        if (
            !$ua ||
            preg_match(
                "/bot|spider|crawler|headless|preview|curl|wget|python|facebookexternalhit/i",
                $ua,
            )
        ) {
            wp_send_json(["ok" => true, "ignored" => true]);
        }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        try {
            if (
                ($_SERVER["REQUEST_METHOD"] ?? "") !== "POST" ||
                (int) ($_SERVER["CONTENT_LENGTH"] ?? 0) > 12000
            ) {
                throw new RuntimeException("STATISTICS_REQUEST");
            }
            $origin =
                $_SERVER["HTTP_ORIGIN"] ?? ($_SERVER["HTTP_REFERER"] ?? "");
            $u = wp_parse_url($origin);
            $home = wp_parse_url(home_url("/"));
            if (
                !is_array($u) ||
                strtolower($u["host"] ?? "") !==
                    strtolower($home["host"] ?? "") ||
                ($u["scheme"] ?? "") !== ($home["scheme"] ?? "") ||
                ($u["port"] ?? null) !== ($home["port"] ?? null) ||
                isset($u["user"]) ||
                isset($u["pass"])
            ) {
                throw new RuntimeException("STATISTICS_ORIGIN");
            }
            if (!$this->option(self::VERSION, 0)) {
                throw new RuntimeException("STATISTICS_NOT_READY");
            }
            $input = [];
            foreach (
                ["pageToken", "eventId", "sessionId", "at", "source"]
                as $key
            ) {
                if (!isset($_POST[$key]) || !is_string($_POST[$key])) {
                    throw new RuntimeException("STATISTICS_REQUEST");
                }
                $input[$key] = wp_unslash($_POST[$key]);
            }
            $page = Boykov_Statistics_Core::page(
                $input["pageToken"],
                wp_salt("auth"),
                get_current_blog_id(),
                strtolower($home["host"]),
            );
            $e = Boykov_Statistics_Core::event(
                $input,
                $page,
                time(),
                wp_salt("auth"),
            );
            $rate = hash_hmac(
                "sha256",
                ($_SERVER["REMOTE_ADDR"] ?? "unknown") .
                    ":" .
                    (int) floor(time() / 60),
                wp_salt("auth"),
            );
            $duplicate = $this->ledger()->capture(
                $e,
                $this->network(),
                $rate,
                time(),
            );
            $wpdb->suppress_errors($old);
            wp_send_json([
                "ok" => true,
                "eventId" => $e["id"],
                "duplicate" => $duplicate,
            ]);
        } catch (Throwable $e) {
            $wpdb->suppress_errors($old);
            $message = $e->getMessage();
            $code =
                $message === "STATISTICS_RATE_LIMIT"
                    ? 429
                    : ($message === "STATISTICS_CONFLICT"
                        ? 409
                        : (in_array(
                            $message,
                            [
                                "STATISTICS_BUSY",
                                "STATISTICS_DATABASE",
                                "STATISTICS_STORAGE_MISSING",
                                "STATISTICS_NOT_READY",
                            ],
                            true,
                        )
                            ? 503
                            : 400));
            wp_send_json(
                ["ok" => false, "error" => "STATISTICS_NOT_ACCEPTED"],
                $code,
            );
        }
    }
    public function run()
    {
        if (
            !Boykov_Leads_Plugin::correct_host() ||
            get_current_blog_id() !== $this->coordinator()
        ) {
            throw new RuntimeException("STATISTICS_COORDINATOR");
        }
        global $wpdb;
        $old = $wpdb->suppress_errors(true);
        $lock = new Boykov_Leads_Queue($wpdb, "statistics:" . $this->network());
        try {
            if (!$lock->acquire()) {
                return ["busy" => true];
            }
            try {
                $config = $this->option(Boykov_Leads_Plugin::CONFIG);
                if (!isset($config["endpoint"], $config["token"])) {
                    throw new RuntimeException("STATISTICS_NOT_CONFIGURED");
                }
                $ep = Boykov_Leads_Payload::endpoint($config["endpoint"]);
                $endpoint = str_replace(
                    "/hooks/leads/",
                    "/hooks/statistics/",
                    $ep["url"],
                );
                $since = (int) $this->option(self::VERSION, 0);
                if (!$since) {
                    throw new RuntimeException("STATISTICS_NOT_READY");
                }
                $stamp = Boykov_Statistics_Core::date(
                    (int) floor(time() / 60) * 60,
                );
                $packet = $this->option(self::SNAPSHOT);
                if (
                    !is_array($packet) ||
                    ($packet["generatedAt"] ?? "") !== $stamp
                ) {
                    $tables = [];
                    $ids = Boykov_Leads_Plugin::network_mode()
                        ? Boykov_Leads_Plugin::network_sites()
                        : [get_current_blog_id()];
                    if (!$ids) {
                        throw new RuntimeException("STATISTICS_NO_SITES");
                    }
                    foreach ($ids as $id) {
                        if (Boykov_Leads_Plugin::network_mode()) {
                            switch_to_blog($id);
                        }
                        try {
                            (new Boykov_Leads_Queue($wpdb))->check();
                            $tables[] = $wpdb->prefix . "boykov_lead_outbox";
                        } finally {
                            if (Boykov_Leads_Plugin::network_mode()) {
                                restore_current_blog();
                            }
                        }
                    }
                    $packet = $this->ledger()->collect(
                        $this->network(),
                        $tables,
                        $since,
                        time(),
                    );
                    $this->save(self::SNAPSHOT, $packet);
                }
                if (!$lock->owns_lock()) {
                    throw new RuntimeException("STATISTICS_LOCK_LOST");
                }
                $r = Boykov_Leads_Plugin::http(
                    $endpoint,
                    wp_json_encode(
                        $packet,
                        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
                    ),
                    $config["token"],
                );
                $body = is_wp_error($r)
                    ? null
                    : json_decode(wp_remote_retrieve_body($r), true);
                if (
                    is_wp_error($r) ||
                    !in_array(
                        wp_remote_retrieve_response_code($r),
                        [200, 201],
                        true,
                    ) ||
                    !is_array($body) ||
                    ($body["ok"] ?? false) !== true ||
                    ($body["siteId"] ?? "") !== $ep["site_id"] ||
                    ($body["generatedAt"] ?? "") !== $packet["generatedAt"]
                ) {
                    throw new RuntimeException(
                        "STATISTICS_DELIVERY_UNCONFIRMED",
                    );
                }
                $this->save(self::STATE, [
                    "last_run" => time(),
                    "last_delivery" => time(),
                    "generated_at" => $packet["generatedAt"],
                    "error" => "",
                ]);
                $this->ledger()->cleanup(time());
                return ["ok" => true];
            } finally {
                $lock->release();
            }
        } catch (Throwable $e) {
            $this->error($e);
            throw $e;
        } finally {
            $wpdb->suppress_errors($old);
        }
    }
    public function scheduled_run()
    {
        if (
            !Boykov_Leads_Plugin::correct_host() ||
            get_current_blog_id() !== $this->coordinator()
        ) {
            return;
        }
        try {
            $this->run();
        } catch (Throwable $e) {
        }
    }
    public function manual_run()
    {
        $cap = Boykov_Leads_Plugin::network_mode()
            ? "manage_network_options"
            : "manage_options";
        if (!Boykov_Leads_Plugin::correct_host() || !current_user_can($cap)) {
            wp_die("Недостаточно прав.");
        }
        check_admin_referer("boykov_statistics_admin");
        try {
            $this->setup();
            $this->run();
        } catch (Throwable $e) {
        }
        wp_safe_redirect(admin_url("options-general.php?page=boykov-leads"));
        exit();
    }
    public function deactivate()
    {
        $ids = Boykov_Leads_Plugin::network_mode()
            ? Boykov_Leads_Plugin::network_sites()
            : [get_current_blog_id()];
        foreach ($ids as $id) {
            if (Boykov_Leads_Plugin::network_mode()) {
                switch_to_blog($id);
            }
            try {
                wp_clear_scheduled_hook(self::HOOK);
            } finally {
                if (Boykov_Leads_Plugin::network_mode()) {
                    restore_current_blog();
                }
            }
        }
    }
    public function render_page()
    {
        $s = $this->option(self::STATE);
        $since = (int) $this->option(self::VERSION, 0);
        echo "<hr><h2>Посещаемость · Энерго 365 и поддомены</h2><p>Собственный учёт визитов и просмотров. Статьи определяются типом записи WordPress. Заявки считаются по сохранённым формам. Общий источник охватывает только energo-365.ru и его поддомены.</p>";
        echo '<table class="widefat striped"><tbody>';
        foreach (
            [
                "Начало учёта" => $since
                    ? gmdate("d.m.Y H:i:s", $since + 10800) . " МСК"
                    : "Ожидает инициализации",
                "Последний запуск" => empty($s["last_run"])
                    ? "Ещё не было"
                    : gmdate("d.m.Y H:i:s", $s["last_run"] + 10800) . " МСК",
                "Подтверждённая доставка" => empty($s["last_delivery"])
                    ? "Ещё не было"
                    : gmdate("d.m.Y H:i:s", $s["last_delivery"] + 10800) .
                        " МСК",
                "Код ошибки" => !empty($s["error"]) ? $s["error"] : "—",
            ]
            as $label => $value
        ) {
            echo "<tr><th>" .
                esc_html($label) .
                "</th><td>" .
                esc_html($value) .
                "</td></tr>";
        }
        echo '</tbody></table><form method="post" action="' .
            esc_url(admin_url("admin-post.php")) .
            '">';
        wp_nonce_field("boykov_statistics_admin");
        echo '<input type="hidden" name="action" value="boykov_statistics_run">';
        submit_button("Отправить статистику и проверить", "secondary");
        echo "</form><p>Расписание — каждую минуту через уже настроенный WP-Cron. После обновления очистите кэш страниц и Autoptimize. Проверьте публичные страницы в приватном окне: визиты вошедших в WordPress пользователей, роботов и браузеров с DNT/GPC не учитываются.</p>";
    }
}
