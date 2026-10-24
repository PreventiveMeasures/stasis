console.log('require', require('dual'))
import('dual').then((m) => console.log('import', m.default), (e) => console.log('import failed', e.code))
