<?php

namespace Acme\LaravelExt;

class ExtServiceProvider
{
    public function register()
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/ext.php', 'ext');
    }
}
