
ICONS_SRC += icons/alt-copy-16.png icons/alt-copy-48.png
ICONS_SRC += icons/alt-copy-32.png icons/alt-copy-96.png
BACKGROUND_SRC = acp_cs_extract.js acp_background.js

firefox-dist:
	set -e ; \
	out="`cat manifest.json | \
		python3 -c "import json, sys; print(json.load(sys.stdin)['version'])"`" ; \
	file="alt-copy-$${out}.unsigned.xpi" ; \
	$(RM) "$$file" ; \
	zip --must-match "$$file" manifest.json $(BACKGROUND_SRC) $(ICONS_SRC) ; \
	echo "Created $$file"

.PHONY: firefox-dist
