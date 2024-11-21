#!/usr/bin/env sh
set -e

### CHANGE CONFIGURATION AT THE END OF THE FILE ###

configure_screen() {
	local rotation="$1"
	case "${rotation}" in
		normal) touchRotation='1 0 0 0 1 0 0 0 1';;
		left) touchRotation='0 -1 1 1 0 0 0 0 1';;
		right) touchRotation='0 1 0 -1 0 1 0 0 1';;
		*) echo "Unknown rotation '${rotation}'..."; exit 1;;
	esac
	screenRotation="${rotation}"

	xrandr -o "${screenRotation}" \
		&& xset s off \
		&& xset s noblank \
		&& xset -dpms
}

configure_touch() {
	local screen="$1"
	xinput set-prop "${screen}" --type=float 'Coordinate Transformation Matrix' $touchRotation
}

### CHANGE CONFIGURATION BELOW TO MATCH THE CONNECTED SCREEN ###

# One of: normal, left, right
configure_screen right
# Find the screen name under "Virtual core pointer" of the following command:
#   xinput list
configure_touch 'ILITEK ILITEK-TP'
