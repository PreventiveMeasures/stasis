console.log(require('reqonly'))
import('reqonly').then((m) => console.log('import ok', m.default), (e) => console.log('import failed', e.code))
