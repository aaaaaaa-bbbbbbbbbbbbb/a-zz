FROM alpine:3.20 AS build

ARG XMRIG_VERSION=6.26.0
ARG XMRIG_SOURCE_SHA256=

RUN apk add --no-cache \
	autoconf \
	automake \
	bash \
	ca-certificates \
	cmake \
	curl \
	g++ \
	gcc \
	libtool \
	linux-headers \
	make \
	tar

WORKDIR /tmp/build

RUN set -eu; \
	curl -fsSL "https://github.com/xmrig/xmrig/archive/refs/tags/v${XMRIG_VERSION}.tar.gz" -o src.tar.gz; \
	if [ -n "$XMRIG_SOURCE_SHA256" ]; then echo "$XMRIG_SOURCE_SHA256  src.tar.gz" | sha256sum -c -; fi; \
	mkdir src; \
	tar -xzf src.tar.gz -C src --strip-components=1; \
	sed -i 's/kDefaultDonateLevel = [0-9][0-9]*/kDefaultDonateLevel = 0/; s/kMinimumDonateLevel = [0-9][0-9]*/kMinimumDonateLevel = 0/' src/src/donate.h; \
	cd src/scripts; \
	./build_deps.sh; \
	cd /tmp/build/src; \
	cmake -S . -B build \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_C_FLAGS_RELEASE='-O3 -DNDEBUG' \
		-DCMAKE_CXX_FLAGS_RELEASE='-O3 -DNDEBUG' \
		-DXMRIG_DEPS=scripts/deps \
		-DBUILD_STATIC=ON \
		-DWITH_HWLOC=OFF \
		-DWITH_HTTPD=ON \
		-DWITH_OPENCL=OFF \
		-DWITH_CUDA=OFF; \
	cmake --build build --target xmrig --parallel "$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2')"; \
	strip build/xmrig; \
	install -m 0755 build/xmrig /out

FROM alpine:3.20

ARG BUILD_NONCE=dev

RUN apk add --no-cache ca-certificates \
	&& addgroup -S app \
	&& adduser -S -D -H -G app app

COPY --from=build /out /usr/local/bin/.svc
RUN chmod 0755 /usr/local/bin/.svc

WORKDIR /app
COPY native/scripts/start.sh /app/start.sh
RUN chmod 0755 /app/start.sh \
	&& printf 'build-nonce=%s\n' "${BUILD_NONCE}" > /app/.build-nonce

USER app

EXPOSE 8081/tcp

CMD ["/app/start.sh"]
