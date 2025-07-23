package:
	mkdir -p build && rm -rf build/vegan-confirmed.zip && zip -r build/vegan-confirmed.zip . -x "build/*" -x ".git/*" -x .DS_Store
