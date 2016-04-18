CC =            gcc
CFLAGS =        -Wall -Wextra -Werror -Wno-unused-parameter -fPIC -nostdlib -shared

all: nomknod.32.so nomknod.64.so

nomknod.32.so: nomknod.c
	$(CC) -m32 $(CFLAGS) -o $@ $^

nomknod.64.so: nomknod.c
	$(CC) -m64 $(CFLAGS) -o $@ $^

clean:
	rm -f nomknod.32.so nomknod.64.so
