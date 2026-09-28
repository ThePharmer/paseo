cmake_minimum_required(VERSION 3.22)
project(paseo_gc_pressure)
set(CMAKE_CXX_STANDARD 20)

# jsi comes from the react-android prefab; the app ships libjsi.so and libc++_shared.so.
find_package(ReactAndroid REQUIRED CONFIG)

add_library(paseo_gc_pressure SHARED ../cpp/balloon-finalizer.cpp)
target_compile_options(paseo_gc_pressure PRIVATE -O2 -Wall -Wextra)
target_link_options(paseo_gc_pressure PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(paseo_gc_pressure PRIVATE ReactAndroid::jsi)
