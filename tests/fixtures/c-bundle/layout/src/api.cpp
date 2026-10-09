#include <mylib/api.hpp>

#include "detail.hpp"

namespace mylib {
std::string greet(const std::string& name) { return detail::prefix() + name; }
}
