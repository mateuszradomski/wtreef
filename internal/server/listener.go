package server

import (
	"net"
	"sync"
)

// LimitListener caps open connections. Accept waits for a free slot, so the
// per-connection goroutines, request contexts, and singleflight waiters are
// all bounded by connectionsMax.
func LimitListener(listener net.Listener, connectionsMax int) net.Listener {
	assert(listener != nil, "listener is required")
	assert(connectionsMax >= 1, "at least one connection is allowed")
	return &limitedListener{
		Listener: listener,
		slots:    make(chan struct{}, connectionsMax),
		done:     make(chan struct{}),
	}
}

type limitedListener struct {
	net.Listener
	slots chan struct{}
	// done unblocks an Accept waiting for a slot when the listener closes.
	done      chan struct{}
	closeOnce sync.Once
}

type limitedConnection struct {
	net.Conn
	slots       chan struct{}
	releaseOnce sync.Once
}

func (listener *limitedListener) Accept() (net.Conn, error) {
	select {
	case listener.slots <- struct{}{}:
	case <-listener.done:
		return nil, net.ErrClosed
	}
	connection, err := listener.Listener.Accept()
	if err != nil {
		<-listener.slots
		return nil, err
	}
	return &limitedConnection{Conn: connection, slots: listener.slots}, nil
}

func (listener *limitedListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.done) })
	return listener.Listener.Close()
}

// Close releases the slot exactly once, however often it is called.
func (connection *limitedConnection) Close() error {
	err := connection.Conn.Close()
	connection.releaseOnce.Do(func() { <-connection.slots })
	return err
}
