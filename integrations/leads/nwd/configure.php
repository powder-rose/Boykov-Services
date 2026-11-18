<?php
if (PHP_SAPI !== 'cli' || $argc !== 3) exit(2);
umask(0077);
$root = realpath($argv[1]);
$private = rtrim($argv[2],'/');
$token = trim((string)fgets(STDIN));
if (!$root || !preg_match('/^[a-f0-9]{64}$/D',$token) || substr($private,0,1) !== '/' || strpos($private.'/', $root.'/') === 0) { echo "INVALID_CONFIGURATION\n"; exit(2); }
if (!is_dir($private) && !mkdir($private,0700,true)) exit(2);
$private = realpath($private);
if (!$private || strpos($private.'/', $root.'/') === 0) { echo "PRIVATE_DIRECTORY_IS_PUBLIC\n"; exit(2); }
$file = $private.'/config.php';
if (is_file($file)) copy($file,$private.'/config-before-'.gmdate('YmdHis').'.php');
$config = array('root'=>$root,'state_dir'=>$private,'endpoint'=>'https://boykov-services.ru/hooks/leads/nwd','token'=>$token);
$temporary = tempnam($private,'.config-');
$source = "<?php\nif (PHP_SAPI !== 'cli') { http_response_code(404); exit; }\nreturn ".var_export($config,true).";\n";
if (file_put_contents($temporary,$source,LOCK_EX) === false) exit(1);
chmod($temporary,0600);
if (!rename($temporary,$file)) exit(1);
echo "NWD_AGENT_CONFIGURED\n";
