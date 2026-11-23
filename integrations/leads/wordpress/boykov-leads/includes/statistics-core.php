<?php
if (!defined("ABSPATH")) {
    exit();
}
final class Boykov_Statistics_Core
{
    public static function host($host)
    {
        return is_string($host) &&
            strlen($host) <= 253 &&
            preg_match(
                '/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*energo-365\.ru$/D',
                $host,
            );
    }
    public static function path($path)
    {
        if (
            !is_string($path) ||
            strlen($path) > 1800 ||
            !preg_match('~^/(?!/)[^\\\\\x00-\x1f]*$~D', $path)
        ) {
            throw new RuntimeException("STATISTICS_PATH");
        }
        $p = parse_url($path, PHP_URL_PATH);
        if (!is_string($p) || !$p) {
            throw new RuntimeException("STATISTICS_PATH");
        }
        return $p;
    }
    public static function text($value, $length = 250)
    {
        $s = trim(
            preg_replace(
                '/[\x00-\x1f\x7f]/u',
                " ",
                strip_tags((string) $value),
            ),
        );
        preg_match("/^.{0," . $length . "}/us", $s, $m);
        return isset($m[0]) ? $m[0] : "";
    }
    public static function source($value)
    {
        if (
            $value === "direct" ||
            $value === "internal" ||
            $value === "unknown"
        ) {
            return $value;
        }
        if (
            is_string($value) &&
            preg_match('/^utm:[A-Za-z0-9_.-]{1,64}$/D', $value)
        ) {
            return $value;
        }
        if (
            is_string($value) &&
            preg_match('/^ref:([a-z0-9.-]{1,150})$/D', $value, $m)
        ) {
            return "ref:" . $m[1];
        }
        return "unknown";
    }
    public static function sign($page, $secret)
    {
        $body = base64_encode(
            wp_json_encode(
                $page,
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
            ),
        );
        return $body . "." . hash_hmac("sha256", $body, $secret);
    }
    public static function page($token, $secret, $blog, $host)
    {
        if (!is_string($token) || strlen($token) > 6000) {
            throw new RuntimeException("STATISTICS_PAGE");
        }
        $parts = explode(".", $token);
        if (
            count($parts) !== 2 ||
            !hash_equals(hash_hmac("sha256", $parts[0], $secret), $parts[1])
        ) {
            throw new RuntimeException("STATISTICS_SIGNATURE");
        }
        $p = json_decode(base64_decode($parts[0], true), true);
        if (
            !is_array($p) ||
            ($p["blog"] ?? null) !== $blog ||
            ($p["host"] ?? null) !== $host ||
            !self::host($host) ||
            !isset($p["path"], $p["title"]) ||
            !is_bool($p["article"] ?? null)
        ) {
            throw new RuntimeException("STATISTICS_PAGE");
        }
        $p["path"] = self::path($p["path"]);
        $p["title"] = self::text($p["title"]);
        return $p;
    }
    public static function event($input, $page, $now, $secret)
    {
        if (!is_array($input)) {
            throw new RuntimeException("STATISTICS_EVENT");
        }
        foreach (["eventId", "sessionId"] as $key) {
            if (
                !isset($input[$key]) ||
                !is_string($input[$key]) ||
                !preg_match(
                    '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D',
                    $input[$key],
                )
            ) {
                throw new RuntimeException("STATISTICS_EVENT_ID");
            }
        }
        $at = $input["at"] ?? null;
        if (
            !is_scalar($at) ||
            !ctype_digit((string) $at) ||
            (int) $at < $now - 86400 ||
            (int) $at > $now + 120
        ) {
            throw new RuntimeException("STATISTICS_EVENT_TIME");
        }
        $event = [
            "id" => $input["eventId"],
            "sid" => hash_hmac("sha256", $input["sessionId"], $secret),
            "at" => (int) $at,
            "host" => $page["host"],
            "path" => $page["path"],
            "title" => $page["title"],
            "article" => $page["article"],
            "source" => self::source($input["source"] ?? ""),
        ];
        $event["digest"] = hash("sha256", wp_json_encode($event));
        return $event;
    }
    public static function period($key, $now)
    {
        if (!in_array($key, ["24h", "7", "30", "90"], true)) {
            throw new RuntimeException("STATISTICS_PERIOD");
        }
        $end = (int) floor($now / 60) * 60;
        $today = (int) floor(($end + 10800) / 86400) * 86400 - 10800;
        $start =
            $key === "24h" ? $end - 86400 : $today - ((int) $key - 1) * 86400;
        $step = $key === "24h" ? 3600 : 86400;
        $first = (int) floor(($start + 10800) / $step) * $step - 10800;
        $daily = [];
        for ($at = $first; $at < $end; $at += $step) {
            $daily[] = [
                "at" => self::date(max($start, $at)),
                "end" => self::date(min($at + $step, $end)),
                "visits" => 0,
                "views" => 0,
                "articles" => 0,
                "leads" => 0,
            ];
        }
        return [
            "start" => $start,
            "end" => $end,
            "step" => $step,
            "first" => $first,
            "daily" => $daily,
        ];
    }
    public static function date($time)
    {
        return gmdate("Y-m-d\TH:i:s.000\Z", $time);
    }
    public static function label($value)
    {
        if (strpos($value, "utm:") === 0) {
            return "UTM · " . substr($value, 4);
        }
        if (strpos($value, "ref:") === 0) {
            return substr($value, 4);
        }
        return [
            "direct" => "Прямой заход",
            "internal" => "Со страниц сайта",
            "unknown" => "Источник не определён",
        ][$value] ?? "Источник не определён";
    }
}
final class Boykov_Statistics_Ledger
{
    private $db;
    public $views;
    private $sessions;
    private $rate;
    public function __construct($db)
    {
        $this->db = $db;
        $prefix = isset($db->base_prefix) ? $db->base_prefix : $db->prefix;
        if (!preg_match('/^[A-Za-z0-9_]+$/D', $prefix)) {
            throw new RuntimeException("STATISTICS_TABLE");
        }
        $this->views = $prefix . "boykov_statistics_views";
        $this->sessions = $prefix . "boykov_statistics_sessions";
        $this->rate = $prefix . "boykov_statistics_rate";
    }
    private function query($sql)
    {
        $r = $this->db->query($sql);
        if ($r === false) {
            throw new RuntimeException("STATISTICS_DATABASE");
        }
        return $r;
    }
    public function rows($sql)
    {
        $this->db->last_error = "";
        $r = $this->db->get_results($sql, ARRAY_A);
        if (!is_array($r) || $this->db->last_error) {
            throw new RuntimeException("STATISTICS_DATABASE");
        }
        return $r;
    }
    public function install()
    {
        $charset = $this->db->get_charset_collate();
        $this->query(
            "CREATE TABLE IF NOT EXISTS `{$this->views}` (network_id bigint unsigned NOT NULL,event_id varchar(36) NOT NULL,digest char(64) NOT NULL,sid char(64) NOT NULL,viewed_at bigint unsigned NOT NULL,host varchar(253) NOT NULL,path varbinary(1800) NOT NULL,title varchar(500) NOT NULL,article tinyint unsigned NOT NULL,entry tinyint unsigned NOT NULL,source varchar(160) NOT NULL,PRIMARY KEY(network_id,event_id),KEY viewed(network_id,viewed_at)) ENGINE=InnoDB $charset",
        );
        $this->query(
            "CREATE TABLE IF NOT EXISTS `{$this->sessions}` (network_id bigint unsigned NOT NULL,sid char(64) NOT NULL,first_at bigint unsigned NOT NULL,last_at bigint unsigned NOT NULL,entry_id varchar(36) NOT NULL,PRIMARY KEY(network_id,sid),KEY expiry(last_at)) ENGINE=InnoDB $charset",
        );
        $this->query(
            "CREATE TABLE IF NOT EXISTS `{$this->rate}` (network_id bigint unsigned NOT NULL,bucket char(64) NOT NULL,hits int unsigned NOT NULL,created_at bigint unsigned NOT NULL,PRIMARY KEY(network_id,bucket),KEY expiry(created_at)) ENGINE=InnoDB $charset",
        );
        $this->check();
    }
    public function check()
    {
        foreach ([$this->views, $this->sessions, $this->rate] as $table) {
            $engine = $this->db->get_var(
                $this->db->prepare(
                    "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s",
                    $table,
                ),
            );
            if (strtolower((string) $engine) !== "innodb") {
                throw new RuntimeException("STATISTICS_STORAGE_MISSING");
            }
        }
        $this->rows(
            "SELECT network_id,event_id,digest,sid,viewed_at,host,path,title,article,entry,source FROM `{$this->views}` LIMIT 0",
        );
    }
    public function capture($e, $network, $rateKey, $now)
    {
        $lock =
            "byk-stat-" .
            substr(hash("sha256", $network . ":" . $e["sid"]), 0, 40);
        if (
            (string) $this->db->get_var(
                $this->db->prepare("SELECT GET_LOCK(%s,0)", $lock),
            ) !== "1"
        ) {
            throw new RuntimeException("STATISTICS_BUSY");
        }
        try {
            $this->query("START TRANSACTION");
            try {
                $old = $this->rows(
                    $this->db->prepare(
                        "SELECT digest FROM `{$this->views}` WHERE network_id=%d AND event_id=%s",
                        $network,
                        $e["id"],
                    ),
                );
                if ($old) {
                    if (!hash_equals($old[0]["digest"], $e["digest"])) {
                        throw new RuntimeException("STATISTICS_CONFLICT");
                    }
                    $this->query("COMMIT");
                    return true;
                }
                $this->query(
                    $this->db->prepare(
                        "INSERT INTO `{$this->rate}` VALUES(%d,%s,1,%d) ON DUPLICATE KEY UPDATE hits=hits+1",
                        $network,
                        $rateKey,
                        $now,
                    ),
                );
                $rate = $this->rows(
                    $this->db->prepare(
                        "SELECT hits FROM `{$this->rate}` WHERE network_id=%d AND bucket=%s",
                        $network,
                        $rateKey,
                    ),
                );
                if ((int) $rate[0]["hits"] > 180) {
                    throw new RuntimeException("STATISTICS_RATE_LIMIT");
                }
                $session = $this->rows(
                    $this->db->prepare(
                        "SELECT first_at,last_at,entry_id FROM `{$this->sessions}` WHERE network_id=%d AND sid=%s FOR UPDATE",
                        $network,
                        $e["sid"],
                    ),
                );
                $entry = !$session || $e["at"] < (int) $session[0]["first_at"];
                if ($session && $entry) {
                    $this->query(
                        $this->db->prepare(
                            "UPDATE `{$this->views}` SET entry=0 WHERE network_id=%d AND event_id=%s",
                            $network,
                            $session[0]["entry_id"],
                        ),
                    );
                }
                $this->query(
                    $this->db->prepare(
                        "INSERT INTO `{$this->views}` VALUES(%d,%s,%s,%s,%d,%s,%s,%s,%d,%d,%s)",
                        $network,
                        $e["id"],
                        $e["digest"],
                        $e["sid"],
                        $e["at"],
                        $e["host"],
                        $e["path"],
                        $e["title"],
                        (int) $e["article"],
                        (int) $entry,
                        $e["source"],
                    ),
                );
                if (!$session) {
                    $this->query(
                        $this->db->prepare(
                            "INSERT INTO `{$this->sessions}` VALUES(%d,%s,%d,%d,%s)",
                            $network,
                            $e["sid"],
                            $e["at"],
                            $e["at"],
                            $e["id"],
                        ),
                    );
                } else {
                    $this->query(
                        $this->db->prepare(
                            "UPDATE `{$this->sessions}` SET first_at=LEAST(first_at,%d),last_at=GREATEST(last_at,%d),entry_id=%s WHERE network_id=%d AND sid=%s",
                            $e["at"],
                            $e["at"],
                            $entry ? $e["id"] : $session[0]["entry_id"],
                            $network,
                            $e["sid"],
                        ),
                    );
                }
                $this->query("COMMIT");
                return false;
            } catch (Throwable $error) {
                $this->db->query("ROLLBACK");
                throw $error;
            }
        } finally {
            $this->db->get_var(
                $this->db->prepare("SELECT RELEASE_LOCK(%s)", $lock),
            );
        }
    }
    public function collect($network, $queueTables, $since, $now)
    {
        $this->check();
        $reports = [];
        $this->query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
        try {
            foreach (["24h", "7", "30", "90"] as $key) {
                $r = Boykov_Statistics_Core::period($key, $now);
                $daily = $r["daily"];
                $where = $this->db->prepare(
                    "network_id=%d AND viewed_at>=%d AND viewed_at<%d",
                    $network,
                    max($r["start"], $since),
                    $r["end"],
                );
                $rows = $this->rows(
                    "SELECT FLOOR((viewed_at-{$r["first"]})/{$r["step"]}) slot,COUNT(*) views,SUM(entry) visits,SUM(article) articles FROM `{$this->views}` WHERE $where GROUP BY slot",
                );
                foreach ($rows as $row) {
                    foreach (["views", "visits", "articles"] as $metric) {
                        $daily[(int) $row["slot"]][$metric] =
                            (int) $row[$metric];
                    }
                }
                foreach ($queueTables as $table) {
                    if (!preg_match('/^[A-Za-z0-9_]+$/D', $table)) {
                        throw new RuntimeException("STATISTICS_QUEUE");
                    }
                    foreach (
                        $this->rows(
                            $this->db->prepare(
                                "SELECT FLOOR((TIMESTAMPDIFF(SECOND,'1970-01-01 00:00:00',created_at)-%d)/%d) slot,COUNT(*) amount FROM `$table` WHERE created_at>=%s AND created_at<%s GROUP BY slot",
                                $r["first"],
                                $r["step"],
                                gmdate("Y-m-d H:i:s", $r["start"]),
                                gmdate("Y-m-d H:i:s", $r["end"]),
                            ),
                        )
                        as $row
                    ) {
                        $daily[(int) $row["slot"]]["leads"] +=
                            (int) $row["amount"];
                    }
                }
                $sources = [];
                foreach (
                    $this->rows(
                        "SELECT source,COUNT(*) amount FROM `{$this->views}` WHERE $where AND entry=1 GROUP BY source ORDER BY amount DESC,source LIMIT 20",
                    )
                    as $row
                ) {
                    $label = Boykov_Statistics_Core::label($row["source"]);
                    $sources[$label] =
                        ($sources[$label] ?? 0) + (int) $row["amount"];
                }
                $sourceRows = [];
                foreach ($sources as $name => $amount) {
                    $sourceRows[] = ["name" => $name, "visits" => $amount];
                }
                $pages = [];
                foreach (
                    $this->rows(
                        "SELECT host,path,COUNT(*) amount FROM `{$this->views}` WHERE $where GROUP BY host,path ORDER BY amount DESC,host,path LIMIT 20",
                    )
                    as $row
                ) {
                    $pages[] = [
                        "host" => $row["host"],
                        "path" => $row["path"],
                        "title" => $row["path"],
                        "views" => (int) $row["amount"],
                    ];
                }
                $articles = [];
                foreach (
                    $this->rows(
                        "SELECT host,path,MAX(title) title,COUNT(*) amount FROM `{$this->views}` WHERE $where AND article=1 GROUP BY host,path ORDER BY amount DESC,host,path LIMIT 20",
                    )
                    as $row
                ) {
                    $articles[] = [
                        "host" => $row["host"],
                        "path" => $row["path"],
                        "title" => $row["title"] ?: $row["path"],
                        "views" => (int) $row["amount"],
                    ];
                }
                $totals = [];
                foreach (["visits", "views", "articles", "leads"] as $m) {
                    $totals[$m] = array_sum(array_column($daily, $m));
                }
                $reports[] = [
                    "key" => $key,
                    "period" => [
                        "from" => Boykov_Statistics_Core::date($r["start"]),
                        "to" => Boykov_Statistics_Core::date($r["end"]),
                        "group" => $key === "24h" ? "hour" : "day",
                    ],
                    "totals" => $totals,
                    "daily" => $daily,
                    "sources" => $sourceRows,
                    "pages" => $pages,
                    "articles" => $articles,
                ];
            }
            $this->query("COMMIT");
        } catch (Throwable $error) {
            $this->db->query("ROLLBACK");
            throw $error;
        }
        return [
            "version" => 1,
            "host" => "energo-365.ru",
            "source" => "wordpress",
            "generatedAt" => Boykov_Statistics_Core::date(
                (int) floor($now / 60) * 60,
            ),
            "coverageFrom" => Boykov_Statistics_Core::date($since),
            "reports" => $reports,
        ];
    }
    public function cleanup($now)
    {
        $this->query(
            $this->db->prepare(
                "DELETE FROM `{$this->views}` WHERE viewed_at<%d",
                $now - 93 * 86400,
            ),
        );
        $this->query(
            $this->db->prepare(
                "DELETE FROM `{$this->sessions}` WHERE last_at<%d",
                $now - 94 * 86400,
            ),
        );
        $this->query(
            $this->db->prepare(
                "DELETE FROM `{$this->rate}` WHERE created_at<%d",
                $now - 3600,
            ),
        );
    }
}
