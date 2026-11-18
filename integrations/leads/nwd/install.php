<?php
// CLI only. Install using the same PHP binary as the existing NWD panel.
if (PHP_SAPI !== 'cli' || $argc !== 3 || PHP_VERSION_ID < 70000) { fwrite(STDERR, "Usage: PHP7+ install.php SITE_ROOT PRIVATE_DIRECTORY\n"); exit(2); }
umask(0077);
$root = realpath($argv[1]);
$private = rtrim($argv[2], '/');
if (!$root || !is_file($root.'/redaktsiya/lib/db.php') || strpos($private.'/', $root.'/') === 0 || substr($private,0,1) !== '/') { fwrite(STDERR,"INVALID_INSTALL_PATH\n"); exit(2); }
if (!is_dir($private) && !mkdir($private, 0700, true)) exit(2);
$private = realpath($private);
if (!$private || strpos($private.'/', $root.'/') === 0) { fwrite(STDERR,"PRIVATE_DIRECTORY_IS_PUBLIC\n"); exit(2); }
$backup = $private.'/backup-'.gmdate('Ymd-His').'-'.bin2hex(random_bytes(4));
mkdir($backup, 0700);
define('NWD_PANEL', true);
require $root.'/redaktsiya/lib/db.php';
require __DIR__.'/hub.php';
try {
    panelDb();
    foreach (array('feedback','feedback_param_element','nwd_feedback_request','postman') as $name) {
        $physical = str_replace('`','', panelTable($name));
        $engine = panelRow('SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', array($physical));
        if (!$engine || strtoupper($engine['engine']) !== 'INNODB') throw new RuntimeException('SOURCE_TABLE_NOT_TRANSACTIONAL_'.$name);
    }
    $handler = $root.'/custom/energo/modules/feedback/feedback.action.php';
    $helper = $root.'/custom/energo/modules/feedback/boykov-hub.php';
    $original = file_get_contents($handler);
    $marker = 'BOYKOV_HUB_ENQUEUE_V1';
    $needle = "DB::query('COMMIT');";
    if (strpos($original,$marker) === false && substr_count($original,$needle) !== 1) throw new RuntimeException('UNEXPECTED_HANDLER_VERSION');
    if (strpos($original, 'nwdFeedbackLead(') === false || strpos($original, '$receipt[\'feedback_id\']') === false) throw new RuntimeException('UNEXPECTED_FEEDBACK_FLOW');
    copy($handler,$backup.'/feedback.action.php');
    if (is_file($helper)) copy($helper,$backup.'/boykov-hub.php');
    panelQuery('CREATE TABLE IF NOT EXISTS '.panelTable('boykov_lead_outbox')." (
        event_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        payload MEDIUMTEXT NOT NULL,payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
        queued_at BIGINT NOT NULL,delivered TINYINT NOT NULL DEFAULT 0,
        attempts INT NOT NULL DEFAULT 0,next_at BIGINT NOT NULL DEFAULT 0,
        last_error VARCHAR(64) NOT NULL DEFAULT '',receipt VARCHAR(160) NOT NULL DEFAULT '',
        INDEX delivery_due(delivered,next_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", array());
    $insertion = "// BOYKOV_HUB_ENQUEUE_V1\n".
        "            require_once ABSOLUTE_PATH.'custom/energo/modules/feedback/boykov-hub.php';\n".
        "            if (\$repeated) { \$lead = nwdFeedbackLead((int)\$receipt['feedback_id'], \$this->site_id); }\n".
        "            nwdHubEnqueue(\$lead, \$requestId);\n            ".$needle;
    $updated = strpos($original,$marker) !== false ? $original : str_replace($needle,$insertion,$original);
    $temporary = tempnam(dirname($handler),'.boykov-hub-');
    file_put_contents($temporary,$updated,LOCK_EX);
    try { token_get_all($updated, TOKEN_PARSE); }
    catch (Throwable $error) { unlink($temporary); throw new RuntimeException('PATCHED_HANDLER_LINT_FAILED'); }
    $helperTemporary = tempnam(dirname($helper),'.boykov-helper-');
    if (!copy(__DIR__.'/hub.php',$helperTemporary)) throw new RuntimeException('HELPER_COPY_FAILED');
    chmod($helperTemporary,0644);
    if (!rename($helperTemporary,$helper)) throw new RuntimeException('HELPER_ACTIVATION_FAILED');
    chmod($temporary,0644);
    if (!rename($temporary,$handler)) throw new RuntimeException('HANDLER_ACTIVATION_FAILED');
    // Future submissions are captured before backfilling existing records.
    $lang = (int)panelLanguage();
    $last = 0; $count = 0;
    do {
        $rows = panelRows('SELECT f.id,f.created,f.site_id,f.url,s.`name'.$lang.'` AS form,r.request_id AS hub_request_id FROM '.panelTable('feedback').' f LEFT JOIN '.panelTable('site').' s ON s.id=f.site_id LEFT JOIN '.panelTable('nwd_feedback_request').' r ON r.feedback_id=f.id WHERE f.id>? ORDER BY f.id LIMIT 100',array($last));
        foreach ($rows as $lead) {
            $lead['form'] = html_entity_decode(strip_tags(preg_replace('~<br\s*/?>(?:\r?\n)?~i',"\n",(string)$lead['form'])),ENT_QUOTES | ENT_HTML5,'UTF-8');
            if (!$lead['form']) $lead['form'] = 'Обратная связь';
            $lead['fields'] = panelRows("SELECT p.`name$lang` AS label,p.type,CASE WHEN p.type IN ('select','multiple','radio') THEN COALESCE(o.`name$lang`,v.value) WHEN p.type='checkbox' THEN IF(v.value='1','Да','Нет') ELSE v.value END AS value FROM ".panelTable('feedback_param_element').' v JOIN '.panelTable('feedback_param').' p ON p.id=v.param_id LEFT JOIN '.panelTable('feedback_param_select')." o ON o.param_id=v.param_id AND o.id=v.value AND o.trash='0' WHERE v.element_id=? AND v.trash='0' ORDER BY p.sort,v.id",array($lead['id']));
            foreach ($lead['fields'] as &$field) {
                foreach (array('label','value') as $key) $field[$key] = html_entity_decode(strip_tags(preg_replace('~<br\s*/?>(?:\r?\n)?~i',"\n",(string)$field[$key])),ENT_QUOTES | ENT_HTML5,'UTF-8');
            }
            unset($field);
            $payload = nwdHubPayload($lead, isset($lead['hub_request_id']) ? $lead['hub_request_id'] : '');
            $json = nwdHubEncode($payload);
            panelQuery('INSERT IGNORE INTO '.panelTable('boykov_lead_outbox').' (event_id,payload,payload_hash,queued_at) VALUES (?,?,?,?)',array($payload['eventId'],$json,hash('sha256',$json),time()));
            $last = (int)$lead['id']; $count++;
        }
    } while (count($rows) === 100);
    echo "NWD_OUTBOX=INSTALLED\nBACKFILLED_ROWS=$count\nBACKUP=$backup\n";
} catch (Throwable $error) {
    // Never expose SQL/credentials or customer data through the terminal.
    $code = get_class($error);
    if (preg_match('/^(?:SOURCE_TABLE_NOT_TRANSACTIONAL_|UNEXPECTED_|[A-Z_]+_FAILED)[a-zA-Z0-9_]*$/D',$error->getMessage())) $code = $error->getMessage();
    echo 'NWD_INSTALL_STOPPED='.$code."\nBACKUP=$backup\n";
    exit(1);
}
