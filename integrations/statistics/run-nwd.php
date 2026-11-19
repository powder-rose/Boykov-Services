<?php
if (PHP_SAPI !== 'cli' || PHP_VERSION_ID < 70300 || $argc !== 2) exit(2);
umask(0077);
require __DIR__.'/nwd.php';
$config=require $argv[1];
if (!isset($config['root'],$config['state_dir'],$config['endpoint'],$config['token']) || !preg_match('/^[a-f0-9]{64}$/D',$config['token'])) exit(2);
$url=parse_url($config['endpoint']);
if (!$url || $url['scheme']!=='https' || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) || ($url['path'] ?? '')!=='/hooks/leads/nwd') exit(2);
$endpoint='https://'.$url['host'].(isset($url['port'])?':'.$url['port']:'').'/hooks/statistics/nwd';
$state=rtrim($config['state_dir'],'/').'/statistics';
if (!is_dir($state) && !mkdir($state,0700,true)) exit(1);
$lock=fopen($state.'/sync.lock','c');if(!$lock || !flock($lock,LOCK_EX|LOCK_NB))exit(0);
$packet=null;
try {
    define('NWD_PANEL',true);
    require $config['root'].'/redaktsiya/lib/db.php';
    $db=panelDb();
    $db->begin_transaction(MYSQLI_TRANS_START_READ_ONLY | MYSQLI_TRANS_START_WITH_CONSISTENT_SNAPSHOT);
    try { $packet=nwdStatisticsPacket(time()); $db->commit(); } catch(Throwable $e) { $db->rollback(); throw $e; }
    $json=json_encode($packet,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
    $tmp=tempnam($state,'.packet-');if(file_put_contents($tmp,$json,LOCK_EX)===false)throw new RuntimeException('STATE_WRITE_FAILED');chmod($tmp,0600);if(!rename($tmp,$state.'/last-packet.json'))throw new RuntimeException('STATE_WRITE_FAILED');
} catch (Throwable $error) {
    $json=@file_get_contents($state.'/last-packet.json');
    $packet=is_string($json)?json_decode($json,true):null;
    if(!is_array($packet) || ($packet['host'] ?? '')!=='nwdelectricity.ru'){echo "NWD_STATISTICS=SOURCE_CHECK_REQUIRED\n";exit(1);}
}
$status=0;
try {
    $curl=curl_init($endpoint);
    curl_setopt_array($curl,array(CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$json,CURLOPT_HTTPHEADER=>array('Content-Type: application/json','Authorization: Bearer '.$config['token']),CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>20,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2));
    $body=curl_exec($curl);$status=(int)curl_getinfo($curl,CURLINFO_HTTP_CODE);curl_close($curl);
    $ack=is_string($body)?json_decode($body,true):null;
    if(!in_array($status,array(200,201),true) || !is_array($ack) || ($ack['ok'] ?? false)!==true || ($ack['siteId'] ?? '')!=='nwd' || ($ack['generatedAt'] ?? '')!==$packet['generatedAt'])throw new RuntimeException('DELIVERY_NOT_CONFIRMED');
    if(time()-strtotime($packet['generatedAt'])>180){echo "NWD_STATISTICS=STALE\n";exit(1);}
    echo 'NWD_STATISTICS=OK GENERATED_AT='.$packet['generatedAt']."\n";
} catch(Throwable $error){echo 'NWD_STATISTICS=DELIVERY_CHECK_REQUIRED HTTP='.$status."\n";exit(1);}
