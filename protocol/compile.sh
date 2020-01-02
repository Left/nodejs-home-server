protoc --nanopb_out=../../BluePillTest/src protocol.proto
protoc --nanopb_out=../../MyWiFiController/src protocol.proto
protoc --plugin=protoc-gen-ts=./../server/node_modules/.bin/protoc-gen-ts --js_out=import_style=commonjs,binary:./../server/generated --ts_out=service=grpc-web:./../server/generated protocol.proto
