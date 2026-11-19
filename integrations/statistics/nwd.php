<?php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
function nwdStatisticsPeriod($key, $now) {
    if (!in_array($key, array('24h','7','30','90'), true)) throw new RuntimeException('INVALID_NATIVE_PERIOD');
    $end = (int)floor($now / 60) * 60;
    $today = (int)floor(($end + 10800) / 86400) * 86400 - 10800;
    $start = $key === '24h' ? $end - 86400 : $today - ((int)$key - 1) * 86400;
    $step = $key === '24h' ? 3600 : 86400;
    $first = (int)floor(($start + 10800) / $step) * $step - 10800;
    $daily = array();
    for ($time = $first; $time < $end; $time += $step) $daily[] = array('at'=>gmdate('Y-m-d\TH:i:s.000\Z', max($time,$start)), 'end'=>gmdate('Y-m-d\TH:i:s.000\Z', min($time+$step,$end)), 'visits'=>0,'views'=>0,'articles'=>0,'leads'=>0);
    return array('start'=>$start,'end'=>$end,'step'=>$step,'first'=>$first,'daily'=>$daily);
}
function nwdStatisticsSource($value) {
    if (strpos($value,'utm:') === 0) return 'UTM · '.substr($value,4);
    if (strpos($value,'ref:') === 0) return substr($value,4);
    return array('direct'=>'Прямой заход','internal'=>'Со страниц сайта','unknown'=>'Источник не определён')[$value] ?? 'Источник не определён';
}
function nwdStatisticsPacket($now) {
    $reports = array();
    $views = panelTable('panel_traffic_view');
    $feedback = panelTable('feedback');
    foreach (array('24h','7','30','90') as $key) {
        $r = nwdStatisticsPeriod($key,$now); $daily = $r['daily']; $period = array($r['start'],$r['end']);
        $rows = panelRows("SELECT FLOOR((viewed_at-?)/?) slot, COUNT(*) views,SUM(entry) visits,SUM(article_site_id>0) articles FROM $views WHERE viewed_at>=? AND viewed_at<? GROUP BY slot",array($r['first'],$r['step'],$r['start'],$r['end']));
        foreach ($rows as $row) foreach (array('visits','views','articles') as $field) $daily[(int)$row['slot']][$field] = (int)$row[$field];
        $rows = panelRows("SELECT FLOOR((created-?)/?) slot,COUNT(*) amount FROM $feedback WHERE trash='0' AND created>=? AND created<? GROUP BY slot",array($r['first'],$r['step'],$r['start'],$r['end']));
        foreach ($rows as $row) $daily[(int)$row['slot']]['leads']=(int)$row['amount'];
        $totals = array(); foreach(array('visits','views','articles','leads') as $field) $totals[$field]=array_sum(array_column($daily,$field));
        $sources = array();
        foreach(panelRows("SELECT source,COUNT(*) amount FROM $views WHERE viewed_at>=? AND viewed_at<? AND entry=1 GROUP BY source ORDER BY amount DESC,source LIMIT 20",$period) as $row) {
            $label=nwdStatisticsSource($row['source']);$sources[$label]=($sources[$label] ?? 0)+(int)$row['amount'];
        }
        $sourceRows=array();foreach($sources as $name=>$amount)$sourceRows[]=array('name'=>$name,'visits'=>$amount);
        $pages=array();foreach(panelRows("SELECT path,COUNT(*) amount FROM $views WHERE viewed_at>=? AND viewed_at<? GROUP BY path ORDER BY amount DESC,path LIMIT 20",$period) as $row)$pages[]=array('path'=>$row['path'],'title'=>$row['path'],'views'=>(int)$row['amount']);
        $ranked=panelRows("SELECT ranked.path,ranked.amount,a.title FROM (SELECT article_site_id,MIN(path) path,COUNT(*) amount FROM $views WHERE viewed_at>=? AND viewed_at<? AND article_site_id>0 GROUP BY article_site_id ORDER BY amount DESC,article_site_id LIMIT 20) ranked LEFT JOIN ".panelTable('panel_article')." a ON a.site_id=ranked.article_site_id ORDER BY ranked.amount DESC,ranked.article_site_id",$period);
        $articles=array();foreach($ranked as $row){$p=$row['path'];if(isset($articles[$p]))$articles[$p]['views']+=(int)$row['amount'];else $articles[$p]=array('path'=>$p,'title'=>$row['title'] ?: $p,'views'=>(int)$row['amount']);}
        $reports[]=array('key'=>$key,'period'=>array('from'=>gmdate('Y-m-d\TH:i:s.000\Z',$r['start']),'to'=>gmdate('Y-m-d\TH:i:s.000\Z',$r['end']),'group'=>$key==='24h'?'hour':'day'),'totals'=>$totals,'daily'=>$daily,'sources'=>$sourceRows,'pages'=>$pages,'articles'=>array_values($articles));
    }
    return array('version'=>1,'host'=>'nwdelectricity.ru','source'=>'nwd','generatedAt'=>gmdate('Y-m-d\TH:i:s.000\Z',(int)floor($now/60)*60),'reports'=>$reports);
}
