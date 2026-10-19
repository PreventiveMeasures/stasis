#include "always.h"
#if 0
#include "dead.h"
#else
#include "alive.h"
#endif
#ifdef _WIN32
#include "win32.h"
#endif
#if defined(HAVE_EXTRA)
#include "extra.h"
#endif
/* #include "commented.h" */
// #include "commented.h"
static const char *s = "#include \"string.h\"";
