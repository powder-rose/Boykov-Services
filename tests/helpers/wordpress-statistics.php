<?php
// SQLite executes the ledger's transactions and aggregations. Only dialect/lock API is adapted;
// MySQL-specific statements and actual InnoDB locking also have an optional real-MySQL run.
class Statistics_SQLite_DB
{
    public $prefix = "wp_";
    public $base_prefix = "wp_";
    public $last_error = "";
    private $pdo;
    public function __construct()
    {
        $this->pdo = new PDO("sqlite::memory:");
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->sqliteCreateFunction("FLOOR", "floor");
        $this->pdo->sqliteCreateFunction("LEAST", "min");
        $this->pdo->sqliteCreateFunction("GREATEST", "max");
    }
    public function suppress_errors($flag = true)
    {
        return false;
    }
    public function get_charset_collate()
    {
        return "";
    }
    public function prepare($sql, ...$args)
    {
        $i = 0;
        return preg_replace_callback(
            "/%[sd]/",
            function ($m) use (&$i, $args) {
                $v = $args[$i++];
                return $m[0] === "%d"
                    ? (string) (int) $v
                    : $this->pdo->quote((string) $v);
            },
            $sql,
        );
    }
    private function adapt($sql)
    {
        $sql = str_replace(
            [
                "START TRANSACTION WITH CONSISTENT SNAPSHOT",
                "START TRANSACTION",
                " FOR UPDATE",
                "ON DUPLICATE KEY UPDATE hits=hits+1",
            ],
            [
                "BEGIN",
                "BEGIN",
                "",
                "ON CONFLICT(network_id,bucket) DO UPDATE SET hits=hits+1",
            ],
            $sql,
        );
        $sql = str_replace(
            "TIMESTAMPDIFF(SECOND,'1970-01-01 00:00:00',created_at)",
            "CAST(strftime('%s',created_at) AS INTEGER)",
            $sql,
        );
        $sql = preg_replace("/,KEY [a-z_]+\([^)]*\)/", "", $sql);
        $sql = str_replace(" ENGINE=InnoDB", "", $sql);
        return $sql;
    }
    public function query($sql)
    {
        try {
            $this->last_error = "";
            return $this->pdo->exec($this->adapt($sql));
        } catch (Throwable $e) {
            $this->last_error = $e->getMessage();
            return false;
        }
    }
    public function get_results($sql, $mode = ARRAY_A)
    {
        try {
            $this->last_error = "";
            return $this->pdo
                ->query($this->adapt($sql))
                ->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            $this->last_error = $e->getMessage();
            return null;
        }
    }
    public function get_var($sql)
    {
        if (strpos($sql, "information_schema.TABLES") !== false) {
            return "InnoDB";
        }
        if (
            preg_match("/SELECT (GET_LOCK|RELEASE_LOCK|IS_USED_LOCK)\(/", $sql)
        ) {
            return 1;
        }
        $r = $this->get_results($sql);
        return $r ? array_values($r[0])[0] : null;
    }
}
function is_user_logged_in()
{
    return !empty($GLOBALS["statistics_logged_in"]);
}
function nocache_headers() {}
function wp_salt($scheme)
{
    return "fixture-private-signing-salt";
}
function wp_send_json($body, $status = 200)
{
    global $wpdb;
    echo wp_json_encode([
        "body" => $body,
        "status" => $status,
        "events" => (int) $wpdb->get_var(
            "SELECT COUNT(*) FROM wp_boykov_statistics_views",
        ),
    ]);
    exit();
}
if ($mode === "statistics-receive") {
    $wpdb = new Statistics_SQLite_DB();
    $ledger = new Boykov_Statistics_Ledger($wpdb);
    $ledger->install();
    update_option(Boykov_Statistics_Plugin::VERSION, time());
    $_SERVER = [
        "REQUEST_METHOD" => "POST",
        "HTTP_USER_AGENT" => "Mozilla/5.0 Example Browser",
        "HTTP_ORIGIN" => $input["origin"] ?? "https://energo-365.ru",
        "REMOTE_ADDR" => "192.0.2.10",
    ];
    if (!empty($input["dnt"])) {
        $_SERVER["HTTP_DNT"] = "1";
    }
    $GLOBALS["statistics_logged_in"] = !empty($input["loggedIn"]);
    $page = [
        "blog" => 1,
        "host" => "energo-365.ru",
        "path" => "/service/",
        "title" => "",
        "article" => false,
    ];
    $_POST = [
        "pageToken" => Boykov_Statistics_Core::sign($page, wp_salt("auth")),
        "eventId" => "11111111-1111-4111-8111-111111111111",
        "sessionId" => "22222222-2222-4222-8222-222222222222",
        "at" => (string) time(),
        "source" => "direct",
    ];
    if (!empty($input["tamper"])) {
        $_POST["pageToken"] .= "x";
    }
    $GLOBALS["boykov_statistics_plugin"]->receive();
    throw new RuntimeException("RECEIVE_DID_NOT_EXIT");
}
if ($mode === "statistics-flow") {
    $GLOBALS["multisite"] = true;
    $GLOBALS["site_hosts"] = [
        1 => "unrelated.invalid",
        2 => "energo-365.ru",
        3 => "lp.energo-365.ru",
        4 => "energo-365.ru.attacker.invalid",
        5 => "office.energo-365.ru",
    ];
    $GLOBALS["cron"][4][Boykov_Leads_Plugin::HOOK] = 123;
    update_site_option("active_sitewide_plugins", [
        "boykov-leads/boykov-leads.php" => time(),
    ]);
    update_site_option(Boykov_Leads_Plugin::COORDINATOR, 2);
    update_site_option(Boykov_Leads_Plugin::CONFIG, $config);
    $wpdb = new Statistics_SQLite_DB();
    $plugin = $GLOBALS["boykov_statistics_plugin"];
    foreach (["wp_2_", "wp_3_", "wp_5_"] as $prefix) {
        $wpdb->query(
            "CREATE TABLE " .
                $prefix .
                "boykov_lead_outbox (id INTEGER,event_id TEXT,payload TEXT,created_at DATETIME,status TEXT,attempts INTEGER,next_attempt_at DATETIME,delivered_at DATETIME,hub_id TEXT,last_error TEXT)",
        );
    }
    switch_to_blog(2);
    $plugin->setup();
    $since = get_site_option(Boykov_Statistics_Plugin::VERSION);
    $plugin->setup();
    $unchanged = $since === get_site_option(Boykov_Statistics_Plugin::VERSION);
    $wpdb->query(
        "INSERT INTO wp_3_boykov_lead_outbox VALUES (1,'lead','private-customer-fields','2026-11-20 13:00:00','pending',0,NULL,NULL,'','')",
    );
    $GLOBALS["statistics_transport"] = function ($url, $args) {
        return ["response" => ["code" => 503], "body" => "{}"];
    };
    try {
        $plugin->run();
        $failed = "accepted";
    } catch (Throwable $e) {
        $failed = $e->getMessage();
    }
    $first = get_site_option(Boykov_Statistics_Plugin::SNAPSHOT);
    $errorState = get_site_option(Boykov_Statistics_Plugin::STATE);
    $GLOBALS["statistics_transport"] = function ($url, $args) {
        $p = json_decode($args["body"], true);
        return [
            "response" => ["code" => 200],
            "body" => wp_json_encode([
                "ok" => true,
                "siteId" => "wrong-site",
                "generatedAt" => $p["generatedAt"],
            ]),
        ];
    };
    try {
        $plugin->run();
        $wrong = "accepted";
    } catch (Throwable $e) {
        $wrong = $e->getMessage();
    }
    $GLOBALS["statistics_transport"] = function ($url, $args) {
        $p = json_decode($args["body"], true);
        return [
            "response" => ["code" => 201],
            "body" => wp_json_encode([
                "ok" => true,
                "siteId" => "fixture",
                "generatedAt" => $p["generatedAt"],
            ]),
        ];
    };
    $ok = $plugin->run();
    $second = get_site_option(Boykov_Statistics_Plugin::SNAPSHOT);
    $state = get_site_option(Boykov_Statistics_Plugin::STATE);
    $request = $GLOBALS["request"];
    switch_to_blog(3);
    try {
        $plugin->run();
        $other = "accepted";
    } catch (Throwable $e) {
        $other = $e->getMessage();
    } finally {
        restore_current_blog();
    }
    $wpdb->query("DROP TABLE wp_3_boykov_lead_outbox");
    update_site_option(Boykov_Statistics_Plugin::SNAPSHOT, []);
    try {
        $plugin->run();
        $missing = "accepted";
    } catch (Throwable $e) {
        $missing = $e->getMessage();
    }
    restore_current_blog();
    echo wp_json_encode([
        "failed" => $failed,
        "wrong" => $wrong,
        "ok" => $ok,
        "same_packet" => $first === $second,
        "error_state" => $errorState,
        "state" => $state,
        "other" => $other,
        "missing" => $missing,
        "restored_blog" => get_current_blog_id(),
        "cron" => $GLOBALS["cron"],
        "start_unchanged" => $unchanged,
        "request" => $request,
        "config" => get_site_option(Boykov_Leads_Plugin::CONFIG),
    ]);
    return;
}
if ($mode === "statistics-core") {
    $secret = "fixture-page-signing-secret";
    $page = [
        "blog" => 2,
        "host" => "lp.energo-365.ru",
        "path" => "/article/?private=removed",
        "article" => true,
        "title" => "<b>Полезная статья</b>",
    ];
    $token = Boykov_Statistics_Core::sign($page, $secret);
    $decoded = Boykov_Statistics_Core::page(
        $token,
        $secret,
        2,
        "lp.energo-365.ru",
    );
    $errors = [];
    foreach (
        [
            [$token . "x", $secret, 2, "lp.energo-365.ru"],
            [$token, $secret, 3, "lp.energo-365.ru"],
            [$token, $secret, 2, "energo-365.ru"],
        ]
        as $args
    ) {
        try {
            call_user_func_array(["Boykov_Statistics_Core", "page"], $args);
            $errors[] = "accepted";
        } catch (Throwable $e) {
            $errors[] = $e->getMessage();
        }
    }
    $event = Boykov_Statistics_Core::event(
        [
            "eventId" => "11111111-1111-4111-8111-111111111111",
            "sessionId" => "22222222-2222-4222-8222-222222222222",
            "at" => $input["now"],
            "source" => "utm:campaign",
        ],
        $decoded,
        $input["now"],
        $secret,
    );
    $periods = [];
    foreach (["24h", "7", "30", "90"] as $key) {
        $periods[$key] = Boykov_Statistics_Core::period($key, $input["now"]);
    }
    echo wp_json_encode([
        "page" => $decoded,
        "errors" => $errors,
        "event" => $event,
        "periods" => $periods,
    ]);
    return;
}
if ($mode !== "statistics-ledger" && $mode !== "statistics-mysql") {
    throw new RuntimeException("UNKNOWN_STATISTICS_MODE");
}
$db = $mode === "statistics-mysql" ? $wpdb : new Statistics_SQLite_DB();
$ledger = new Boykov_Statistics_Ledger($db);
if ($mode === "statistics-mysql") {
    foreach (
        [
            "wp_boykov_statistics_views",
            "wp_boykov_statistics_sessions",
            "wp_boykov_statistics_rate",
            "wp_stats_fixture_leads",
        ]
        as $table
    ) {
        $db->query("DROP TABLE IF EXISTS `" . $table . "`");
    }
}
$ledger->install();
if ($mode === "statistics-mysql") {
    $db->query("SET time_zone='+05:00'");
}
$db->query(
    "CREATE TABLE wp_stats_fixture_leads (created_at DATETIME NOT NULL)",
);
$now = (int) $input["now"];
$end = (int) floor($now / 60) * 60;
$since = $end - 7200;
$secret = "fixture-session-secret";
$ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
];
$session = "55555555-5555-4555-8555-555555555555";
$events = [];
// Delivery order differs from visit order, including a transition between subdomains.
foreach (
    [
        [$ids[0], $session, $end - 60, "lp.energo-365.ru", "/Same/", true],
        [$ids[1], $session, $end - 3601, "energo-365.ru", "/Same/", false],
        [$ids[2], $session, $end - 30, "lp.energo-365.ru", "/same/", true],
        [
            $ids[3],
            "66666666-6666-4666-8666-666666666666",
            $end - 20,
            "energo-365.ru",
            "/Same/",
            false,
        ],
    ]
    as $row
) {
    $e = Boykov_Statistics_Core::event(
        [
            "eventId" => $row[0],
            "sessionId" => $row[1],
            "at" => $row[2],
            "source" => "direct",
        ],
        [
            "host" => $row[3],
            "path" => $row[4],
            "title" => "Инструкция",
            "article" => $row[5],
        ],
        $now,
        $secret,
    );
    $ledger->capture($e, 1, hash("sha256", "fixture"), $now);
    $events[] = $e;
}
$duplicate = $ledger->capture($events[0], 1, hash("sha256", "fixture"), $now);
$conflict = $events[0];
$conflict["digest"] = str_repeat("f", 64);
try {
    $ledger->capture($conflict, 1, hash("sha256", "fixture"), $now);
    $error = "accepted";
} catch (Throwable $e) {
    $error = $e->getMessage();
}
// Another WordPress network must remain isolated.
$ledger->capture($events[0], 2, hash("sha256", "fixture-other"), $now);
foreach ([$end - 1, $end, $end - 40 * 86400] as $at) {
    $db->query(
        $db->prepare(
            "INSERT INTO wp_stats_fixture_leads VALUES(%s)",
            gmdate("Y-m-d H:i:s", $at),
        ),
    );
}
$packet = $ledger->collect(1, ["wp_stats_fixture_leads"], $since, $now);
$before = (int) $db->get_var("SELECT COUNT(*) FROM wp_boykov_statistics_views");
try {
    $ledger->collect(1, ["missing_fixture_queue"], $since, $now);
    $missing = "accepted";
} catch (Throwable $e) {
    $missing = $e->getMessage();
}
$after = (int) $db->get_var("SELECT COUNT(*) FROM wp_boykov_statistics_views");
echo wp_json_encode([
    "packet" => $packet,
    "duplicate" => $duplicate,
    "conflict" => $error,
    "missing" => $missing,
    "rows_before" => $before,
    "rows_after" => $after,
]);
