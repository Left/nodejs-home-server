#!/bin/sh
echo 'Installing adb'
apt-get update
apt-get install -y android-tools-adb 
echo 'Before installing'
adb devices
npm install
echo 'Before starting'
node dist/index