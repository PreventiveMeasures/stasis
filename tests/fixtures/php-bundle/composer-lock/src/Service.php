<?php

namespace App;

use Acme\Lib\Client;

class Service
{
    public function run(): string
    {
        $client = new Client();
        $thing = new \Acme_Legacy_Thing();

        return get_class($client) . get_class($thing);
    }
}
