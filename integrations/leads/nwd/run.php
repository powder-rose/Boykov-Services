<?php
if (PHP_SAPI !== 'cli' || $argc !== 2 || PHP_VERSION_ID < 70000) exit(2);
umask(0077);
$config = require $argv[1];
require __DIR__.'/hub.php';
$lock = fopen($config['state_dir'].'/delivery.lock','c');
if (!$lock || !flock($lock,LOCK_EX | LOCK_NB)) exit(0);
$stats = array('pending'=>0,'rejected'=>0,'scanOk'=>false,'oldestPendingAt'=>null);
define('NWD_PANEL',true);
try {
    require $config['root'].'/redaktsiya/lib/db.php';
    panelDb();
    $handler = file_get_contents($config['root'].'/custom/energo/modules/feedback/feedback.action.php');
    if (strpos($handler,'BOYKOV_HUB_ENQUEUE_V1') === false) throw new RuntimeException('CAPTURE_HOOK_MISSING');
    $table = panelTable('boykov_lead_outbox');
    $report = function() use ($table) {
        $row = panelRow("SELECT COUNT(*) AS pending,MIN(queued_at) AS oldest,SUM(last_error IN ('HTTP_400','HTTP_401','HTTP_403','HTTP_409','HTTP_413','HTTP_415','HTTP_422','INVALID_ACK')) AS rejected FROM $table WHERE delivered=0",array());
        return array('pending'=>(int)$row['pending'],'rejected'=>(int)$row['rejected'],'scanOk'=>true,'oldestPendingAt'=>$row['oldest'] ? gmdate('Y-m-d\TH:i:s.000\Z',(int)$row['oldest']) : null);
    };
    $stats = $report();
    nwdHubRequest($config['endpoint'].'/heartbeat',$config['token'],$stats);
    $fresh = panelRows("SELECT * FROM $table WHERE delivered=0 AND next_at<=? ORDER BY queued_at DESC,event_id DESC LIMIT 10",array(time()));
    $old = panelRows("SELECT * FROM $table WHERE delivered=0 AND next_at<=? ORDER BY queued_at,event_id LIMIT 20",array(time()));
    $rows = array();
    foreach (array_merge($fresh,$old) as $row) { if (!isset($rows[$row['event_id']])) $rows[$row['event_id']] = $row; }
    foreach (array_slice($rows,0,20) as $row) {
        $payload = json_decode($row['payload'],true);
        $error = 'INVALID_SAVED_PAYLOAD';
        if (is_array($payload)) {
            $response = nwdHubRequest($config['endpoint'],$config['token'],$payload);
            $ack = $response['body'];
            if (in_array($response['status'],array(200,201),true) && is_array($ack) && isset($ack['ok'],$ack['siteId'],$ack['eventId'],$ack['id']) && $ack['ok'] === true && $ack['siteId'] === 'nwd' && $ack['eventId'] === $row['event_id'] && is_string($ack['id']) && $ack['id'] !== '') {
                panelQuery("UPDATE $table SET delivered=1,last_error='',receipt=? WHERE event_id=?",array($ack['id'],$row['event_id']));
                continue;
            }
            $error = in_array($response['status'],array(200,201),true) ? 'INVALID_ACK' : 'HTTP_'.$response['status'];
        }
        $delay = min(900,5 * pow(2,min((int)$row['attempts'],8)));
        panelQuery("UPDATE $table SET attempts=attempts+1,next_at=?,last_error=? WHERE event_id=?",array(time()+$delay,$error,$row['event_id']));
    }
    $stats = $report();
    nwdHubRequest($config['endpoint'].'/heartbeat',$config['token'],$stats);
    echo 'NWD_PENDING='.$stats['pending'].' NWD_REJECTED='.$stats['rejected']."\n";
} catch (Throwable $error) {
    $stats['scanOk'] = false;
    try { nwdHubRequest($config['endpoint'].'/heartbeat',$config['token'],$stats); } catch (Throwable $ignored) {}
    echo 'NWD_AGENT_CHECK_REQUIRED='.get_class($error)."\n";
    exit(1);
}
