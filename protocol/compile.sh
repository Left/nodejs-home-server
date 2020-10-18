#!/bin/sh

PATH=$PATH:~/equeumco/vcpkg/installed/x64-osx/tools/protobuf/

set -e # exit on error

echo 'Compiling for ESP8266'
protoc --nanopb_out=../../MyWiFiController/src protocol.proto
echo 'Compiling for TypeScript'
protoc --plugin=protoc-gen-ts=./../server/node_modules/.bin/protoc-gen-ts --js_out=import_style=commonjs,binary:./../server/generated --ts_out=service=grpc-web:./../server/generated protocol.proto
echo 'End'
