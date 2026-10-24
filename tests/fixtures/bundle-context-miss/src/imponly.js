try { console.log(require('imponly')) } catch (e) { console.log('require failed', e.code) }
import('imponly').then((m) => console.log('import ok', m.default), (e) => console.log('import failed', e.code))
